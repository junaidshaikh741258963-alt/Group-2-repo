package com.tripcraft.backend.api;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.hotels.FreeImages;
import com.tripcraft.backend.hotels.JsCompat;
import com.tripcraft.backend.hotels.PlaceQuery;
import com.tripcraft.backend.hotels.PlaceQuery.PlaceContext;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/app/api/place-photos/route.ts} — place photo gallery
 * resolver (free-first).
 *
 * <p>Order: Wikimedia Commons + Openverse (keyless) → RapidAPI Google Images
 * → SerpAPI google_maps → SerpAPI google_images. Results are cached
 * in-memory. SerpAPI is out of quota in this environment, so the free
 * sources are what actually run; an empty-but-valid {@code {"photos": []}} is
 * the correct outcome — never a thrown error.
 */
@RestController
@RequestMapping("/api/place-photos")
public class PlacePhotosController {

    private static final Logger log = LoggerFactory.getLogger(PlacePhotosController.class);

    private static final long CACHE_TTL_MS = 15 * 60_000;
    private static final int CACHE_MAX = 500;
    private static final int FREE_TARGET = 12;
    private static final int MIN_WIDTH = 500;
    private static final Pattern IMAGE_EXT = Pattern.compile("\\.(jpe?g|png|webp)$", Pattern.CASE_INSENSITIVE);

    private static final String RAPID_HOST = trimOrNull(EnvFile.get("RAPIDAPI_IMAGES_HOST"));
    private static final String RAPID_KEY = trimOrNull(EnvFile.get("RAPIDAPI_IMAGES_KEY"));

    /** One gallery image (the TS tracks urls only; the title is used for validation). */
    private record TitleUrl(String url, String title) {
    }

    private record CacheEntry(long at, List<String> photos) {
    }

    private final Map<String, CacheEntry> cache = new LinkedHashMap<>();

    private final SerpApiService serp;

    @Autowired
    public PlacePhotosController(SerpApiService serp) {
        this.serp = serp;
    }

    @PostMapping
    public ResponseEntity<?> placePhotos(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = Json.parseOrNull(raw);
            if (body == null) {
                throw new IllegalArgumentException("Request body is not valid JSON"); // TS: req.json() rejects
            }
            String q = JsCompat.jsTrim(text(body, "name"));
            if (q.isEmpty()) {
                return ResponseEntity.badRequest().body(error("name required"));
            }

            double la = coord(body.get("lat"));
            double lo = coord(body.get("lng"));
            boolean hasCoords = Double.isFinite(la) && Double.isFinite(lo);
            int limit = body.get("count") != null && body.get("count").isNumber()
                    ? (int) Math.min(Math.max(body.get("count").asDouble(), 1), 24)
                    : 12;

            // Full search context: "{place} {city} {country}" (reverse-geocoded when
            // the caller only knows coordinates) so "Le Marais" can't match a wetland.
            PlaceContext ctx = PlaceQuery.resolvePlaceContext(
                    q,
                    hasCoords ? la : null,
                    hasCoords ? lo : null,
                    textOrNull(body, "city"),
                    textOrNull(body, "country"));
            String fullQ = ctx.query();

            String coordsPart = hasCoords ? PlaceQuery.fmt(la, 3) + "," + PlaceQuery.fmt(lo, 3) : "";
            String cacheKey = PlaceQuery.norm(fullQ) + "|" + coordsPart + "|" + limit;
            synchronized (cache) {
                CacheEntry hit = cache.get(cacheKey);
                if (hit != null && System.currentTimeMillis() - hit.at() < CACHE_TTL_MS) {
                    return ResponseEntity.ok(photoList(hit.photos()));
                }
            }

            List<String> out = new ArrayList<>();
            Set<String> seen = new HashSet<>();

            // 1) Free, keyless sources in parallel — validated matches first so a
            //    same-named place elsewhere never wins over the real one.
            CompletableFuture<List<TitleUrl>> commonsFuture =
                    CompletableFuture.supplyAsync(() -> commonsImages(fullQ));
            List<TitleUrl> openverse = openverseImages(fullQ);
            List<TitleUrl> commons = commonsFuture.join();
            List<TitleUrl> free = new ArrayList<>(commons.size() + openverse.size());
            free.addAll(commons);
            free.addAll(openverse);
            List<TitleUrl> validated = new ArrayList<>();
            List<TitleUrl> rejectedList = new ArrayList<>();
            for (TitleUrl c : free) {
                if (PlaceQuery.titleMentions(c.title(), ctx)) {
                    validated.add(c);
                } else {
                    rejectedList.add(c);
                }
            }
            int rejected = rejectedList.size();
            for (TitleUrl c : validated) {
                pushUnique(out, seen, c.url());
            }
            for (TitleUrl c : rejectedList) {
                pushUnique(out, seen, c.url());
            }
            int freeCount = out.size();

            // 2) Top up with the user's RapidAPI key if free sources came up short.
            int rapidCount = 0;
            if (out.size() < FREE_TARGET) {
                for (String u : rapidImageUrls(fullQ)) {
                    pushUnique(out, seen, u);
                    if (out.size() >= FREE_TARGET + 4) {
                        break;
                    }
                }
                rapidCount = out.size() - freeCount;
            }

            // 3) SerpAPI fallbacks when still short.
            int serpCount = 0;
            if (out.size() < FREE_TARGET) {
                for (String u : serpMapsPhotos(fullQ, hasCoords, la, lo)) {
                    pushUnique(out, seen, u);
                    if (out.size() >= FREE_TARGET) {
                        break;
                    }
                }
                serpCount = out.size() - freeCount - rapidCount;
            }
            if (out.isEmpty()) {
                for (String u : serpImageUrls(fullQ)) {
                    pushUnique(out, seen, u);
                }
                serpCount = out.size();
            }

            String cityPart = (ctx.city() != null ? ctx.city() : "?")
                    + (ctx.country() != null && !ctx.country().isEmpty() ? " " + ctx.country() : "");
            log.info("[place-photos] \"{}\" city=\"{}\" \u2192 {} (free {}: validated {}, rejected {}; rapid {}; serp {})",
                    q, cityPart, out.size(), free.size(), validated.size(), rejected, rapidCount, serpCount);

            List<String> photos = List.copyOf(out.subList(0, Math.min(limit, out.size())));

            synchronized (cache) {
                if (cache.size() >= CACHE_MAX) {
                    Iterator<String> oldest = cache.keySet().iterator();
                    if (oldest.hasNext()) {
                        oldest.next();
                        oldest.remove();
                    }
                }
                cache.put(cacheKey, new CacheEntry(System.currentTimeMillis(), photos));
            }

            return ResponseEntity.ok(photoList(photos));
        } catch (Exception err) {
            log.error("Place photos error:", err);
            return ResponseEntity.ok(photoList(List.of()));
        }
    }

    // --------------------------------------------------- free image sources

    /** Wikimedia Commons search — keyless, unlimited, 1200px thumbnails. */
    private static List<TitleUrl> commonsImages(String q) {
        try {
            String url = "https://commons.wikimedia.org/w/api.php?action=query&generator=search"
                    + "&gsrsearch=" + JsCompat.encodeURIComponent(q) + "&gsrnamespace=6&gsrlimit=20"
                    + "&prop=imageinfo&iiprop=url%7Csize&iiurlwidth=1200&format=json&origin=*";
            JsonNode data = FreeImages.fetchJson(url, null, 7000);
            if (data == null) {
                return List.of();
            }
            List<TitleUrl> out = new ArrayList<>();
            for (JsonNode p : FreeImages.jsObjectValues(data.path("query").path("pages"))) {
                String title = p.path("title").isTextual() ? p.path("title").asText() : "";
                if (!IMAGE_EXT.matcher(title).find()) {
                    continue;
                }
                JsonNode infoArray = p.path("imageinfo");
                JsonNode info = infoArray.isArray() && !infoArray.isEmpty() ? infoArray.get(0) : null;
                if (info == null) {
                    continue;
                }
                double w = info.path("width").isNumber() ? info.path("width").asDouble() : 0;
                if (w != 0 && w < MIN_WIDTH) {
                    continue;
                }
                String u = validUrl(info.path("thumburl"));
                if (u == null) {
                    u = validUrl(info.path("url"));
                }
                if (u != null) {
                    out.add(new TitleUrl(u, title));
                }
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** Openverse (Flickr CC etc.) — keyless, rate-limited, cached upstream. */
    private static List<TitleUrl> openverseImages(String q) {
        try {
            String url = "https://api.openverse.org/v1/images/?q=" + JsCompat.encodeURIComponent(q)
                    + "&page_size=20&mature=false";
            JsonNode data = FreeImages.fetchJson(url, Map.of("Accept", "application/json"), 7000);
            if (data == null) {
                return List.of();
            }
            List<TitleUrl> out = new ArrayList<>();
            for (JsonNode r : Json.elements(data.get("results"))) {
                if (Js.truthy(r.get("mature"))) {
                    continue;
                }
                double w = r.path("width").isNumber() ? r.path("width").asDouble() : 0;
                double h = r.path("height").isNumber() ? r.path("height").asDouble() : 0;
                if ((w != 0 && w < MIN_WIDTH) || (h != 0 && h < 350)) {
                    continue;
                }
                String u = validUrl(r.path("url"));
                if (u != null) {
                    out.add(new TitleUrl(u, r.path("title").isTextual() ? r.path("title").asText() : ""));
                }
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    // ------------------------------------------------------ paid fallbacks

    /** Top-up: RapidAPI Google Images (user key), gallery-quality only. */
    private static List<String> rapidImageUrls(String q) {
        if (RAPID_HOST == null || RAPID_KEY == null) {
            return List.of();
        }
        try {
            String url = "https://" + RAPID_HOST + "/getGoogleImages"
                    + "?query=" + JsCompat.encodeURIComponent(q) + "&count=16&imageInfo=true";
            Map<String, String> headers = Map.of(
                    "Content-Type", "application/json",
                    "x-rapidapi-host", RAPID_HOST,
                    "x-rapidapi-key", RAPID_KEY);
            JsonNode data = FreeImages.fetchJson(url, headers, 7000);
            List<String> out = new ArrayList<>();
            for (JsonNode img : Json.arrOr(data, "images")) {
                double w = img.path("width").isNumber() ? img.path("width").asDouble() : 0;
                double h = img.path("height").isNumber() ? img.path("height").asDouble() : 0;
                if (w != 0 && w < MIN_WIDTH) {
                    continue;
                }
                if (h != 0 && h < 350) {
                    continue;
                }
                String u = validUrl(img.path("url"));
                if (u != null) {
                    out.add(u);
                }
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** Last resort: SerpAPI google_maps place/local photos (name-matched). */
    private List<String> serpMapsPhotos(String q, boolean hasCoords, double la, double lo) {
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        try {
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("engine", "google_maps");
            params.put("q", q);
            params.put("type", "search");
            if (hasCoords) {
                params.put("ll", "@" + PlaceQuery.fmt(la, 6) + "," + PlaceQuery.fmt(lo, 6) + ",14z");
            }
            JsonNode data = serp.search(params);
            JsonNode pr = data == null ? null : data.get("place_results");
            if (pr != null && pr.isObject()) {
                pushUnique(out, seen, pr.path("thumbnail"));
                for (JsonNode img : Json.arrOr(pr, "images")) {
                    pushUnique(out, seen, img.path("thumbnail"));
                }
            }
            List<JsonNode> lrs = new ArrayList<>();
            Json.arrOr(data, "local_results").forEach(lrs::add);
            List<JsonNode> matched = new ArrayList<>();
            for (JsonNode r : lrs) {
                if (r.path("title").isTextual() && nameMatches(r.path("title").asText(), q)) {
                    matched.add(r);
                }
            }
            List<JsonNode> picks = !matched.isEmpty() ? matched : lrs.size() == 1 ? lrs : List.of();
            for (JsonNode r : picks) {
                pushUnique(out, seen, r.path("thumbnail"));
            }
        } catch (Exception e) {
            /* ignore */
        }
        return out;
    }

    /** Last-last resort: SerpAPI google_images originals. */
    private List<String> serpImageUrls(String q) {
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        try {
            JsonNode data = serp.search(Map.of("engine", "google_images", "q", q, "num", 10));
            for (JsonNode r : Json.arrOr(data, "images_results")) {
                pushUnique(out, seen, r.path("original"));
                if (out.size() >= 12) {
                    break;
                }
            }
        } catch (Exception e) {
            /* ignore */
        }
        return out;
    }

    // ------------------------------------------------------------ helpers

    private static boolean nameMatches(String a, String b) {
        String na = PlaceQuery.norm(a);
        String nb = PlaceQuery.norm(b);
        if (na.isEmpty() || nb.isEmpty()) {
            return false;
        }
        if (na.contains(nb) || nb.contains(na)) {
            return true;
        }
        Set<String> ta = new HashSet<>(List.of(na.split(" ")));
        String[] tokens = nb.split(" ");
        int hit = 0;
        for (String t : tokens) {
            if (ta.contains(t)) {
                hit++;
            }
        }
        return hit >= Math.max(1, (int) Math.ceil(tokens.length * 0.6));
    }

    /** JS {@code validUrl}: trimmed string starting with http(s)://, else {@code null}. */
    private static String validUrl(JsonNode node) {
        if (node == null || !node.isTextual()) {
            return null;
        }
        String s = JsCompat.jsTrim(node.asText());
        return Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE).matcher(s).find() ? s : null;
    }

    /** String overload — same validation, routed through the {@link JsonNode} path. */
    private static void pushUnique(List<String> out, Set<String> seen, String url) {
        if (url == null) {
            return;
        }
        pushUnique(out, seen, (JsonNode) com.fasterxml.jackson.databind.node.TextNode.valueOf(url));
    }

    private static void pushUnique(List<String> out, Set<String> seen, JsonNode url) {
        String u = validUrl(url);
        if (u == null || seen.contains(u)) {
            return;
        }
        seen.add(u);
        out.add(u);
    }

    /** TS {@code typeof v === "number" ? v : parseFloat(String(v ?? ""))}. */
    private static double coord(JsonNode node) {
        if (node != null && node.isNumber()) {
            return node.asDouble();
        }
        if (node == null || node.isNull()) {
            return Js.parseFloat("");
        }
        return Js.parseFloat(Js.jsString(node));
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : "";
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    private static ObjectNode photoList(List<String> photos) {
        ObjectNode res = Json.obj();
        ArrayNode arr = res.putArray("photos");
        photos.forEach(arr::add);
        return res;
    }

    private static String trimOrNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }
}
