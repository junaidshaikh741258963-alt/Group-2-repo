package com.tripcraft.backend.api;

import java.net.URI;
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
import com.tripcraft.backend.hotels.FreeImages.FreeImage;
import com.tripcraft.backend.hotels.JsCompat;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/app/api/images/route.ts} — free-text image search.
 *
 * <p>Order preserved: short-lived response cache → Wikimedia Commons +
 * Openverse (keyless, fetched in parallel) → optional RapidAPI Google Images
 * top-up (user key) → SerpAPI google_images last resort. SerpAPI is out of
 * quota in this environment, so an empty-but-valid {@code {"images": []}} is
 * the correct outcome there — never a thrown error.
 */
@RestController
@RequestMapping("/api/images")
public class ImagesController {

    private static final Logger log = LoggerFactory.getLogger(ImagesController.class);

    /** Short-lived response cache: the same place is re-queried while browsing. */
    private static final long CACHE_TTL_MS = 5 * 60 * 1000;
    private static final int CACHE_MAX = 200;
    private static final Pattern HTTP_I = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    private final SerpApiService serp;

    private record CacheEntry(long at, List<FreeImage> images) {
    }

    private final Map<String, CacheEntry> responseCache = new LinkedHashMap<>();

    /** Read once at startup, like the TS module-scope {@code process.env} reads. */
    private static final String RAPID_HOST = trimOrNull(EnvFile.get("RAPIDAPI_IMAGES_HOST"));
    private static final String RAPID_KEY = trimOrNull(EnvFile.get("RAPIDAPI_IMAGES_KEY"));

    @Autowired
    public ImagesController(SerpApiService serp) {
        this.serp = serp;
    }

    @PostMapping
    public ResponseEntity<?> search(@RequestBody(required = false) String raw) {
        try {
            JsonNode parsed = Json.parseOrNull(raw);
            JsonNode body = parsed == null ? Json.obj() : parsed; // TS: req.json().catch(() => ({}))
            String query = JsCompat.jsTrim(text(body, "q"));
            if (query.isEmpty()) {
                return ResponseEntity.badRequest().body(error("q required"));
            }

            double count = body.get("num") != null && body.get("num").isNumber()
                    ? Math.min(Math.max(body.get("num").asDouble(), 1), 20)
                    : 8;

            String cacheKey = JsCompat.jsLowerCase(query) + "|" + Js.numStr(count);
            List<FreeImage> cached = readCache(cacheKey);
            if (cached != null && !cached.isEmpty()) {
                return ResponseEntity.ok(imageList(cached));
            }

            // Free-first: Wikimedia Commons + Openverse (keyless) in parallel.
            CompletableFuture<List<FreeImage>> commonsFuture =
                    CompletableFuture.supplyAsync(() -> FreeImages.commonsImages(query));
            List<FreeImage> openverse = FreeImages.openverseImages(query);
            List<FreeImage> commons = commonsFuture.join();

            Set<String> seen = new HashSet<>();
            List<FreeImage> images = new ArrayList<>();
            for (FreeImage img : concat(commons, openverse)) {
                if (!seen.add(img.url())) {
                    continue;
                }
                images.add(img);
                if (images.size() >= count) {
                    break;
                }
            }

            // Top up with the user's RapidAPI Google Images key when free sources fall short.
            if (images.size() < count) {
                for (FreeImage img : rapidImages(query, count)) {
                    if (!seen.add(img.url())) {
                        continue;
                    }
                    images.add(img);
                    if (images.size() >= count) {
                        break;
                    }
                }
            }

            // Last resort: SerpAPI google_images.
            if (images.isEmpty()) {
                images = serpImages(query, count);
            }

            List<FreeImage> result = images.subList(0, Math.min(12, images.size()));
            if (!result.isEmpty()) {
                writeCache(cacheKey, result);
            }
            return ResponseEntity.ok(imageList(result));
        } catch (Exception err) {
            log.error("Images search error:", err);
            return ResponseEntity.ok(imageList(List.of()));
        }
    }

    // -------------------------------------------------------------- cache

    private List<FreeImage> readCache(String key) {
        synchronized (responseCache) {
            CacheEntry hit = responseCache.get(key);
            if (hit == null) {
                return null;
            }
            if (System.currentTimeMillis() - hit.at() > CACHE_TTL_MS) {
                responseCache.remove(key);
                return null;
            }
            return hit.images();
        }
    }

    private void writeCache(String key, List<FreeImage> images) {
        synchronized (responseCache) {
            if (responseCache.size() >= CACHE_MAX) {
                Iterator<String> oldest = responseCache.keySet().iterator();
                if (oldest.hasNext()) {
                    oldest.next();
                    oldest.remove();
                }
            }
            responseCache.put(key, new CacheEntry(System.currentTimeMillis(), images));
        }
    }

    // ------------------------------------------------------------ sources

    /**
     * Primary image source: RapidAPI Google Images ({@code getGoogleImages}).
     * Returns [] on any failure/timeout so callers can fall back.
     */
    private static List<FreeImage> rapidImages(String query, double count) {
        if (RAPID_HOST == null || RAPID_KEY == null) {
            return List.of();
        }
        try {
            String url = "https://" + RAPID_HOST + "/getGoogleImages"
                    + "?query=" + JsCompat.encodeURIComponent(query)
                    + "&count=" + Js.numStr(count) + "&imageInfo=true";
            Map<String, String> headers = Map.of(
                    "Content-Type", "application/json",
                    "x-rapidapi-host", RAPID_HOST,
                    "x-rapidapi-key", RAPID_KEY);
            Http.Raw res = Http.get(url, headers, 6000);
            if (!res.ok()) {
                return List.of();
            }
            JsonNode data = res.json();
            List<FreeImage> out = new ArrayList<>();
            for (JsonNode img : Json.arrOr(data, "images")) {
                String raw = FreeImages.validUrl(img.get("url"));
                if (raw == null) {
                    continue;
                }
                double w = img.path("width").isNumber() ? img.path("width").asDouble() : 0;
                double h = img.path("height").isNumber() ? img.path("height").asDouble() : 0;
                if ((w != 0 && w < 250) || (h != 0 && h < 180)) {
                    continue;
                }
                String source = "";
                try {
                    source = URI.create(raw).getHost() == null ? "" : URI.create(raw).getHost();
                } catch (Exception e) {
                    source = "";
                }
                source = source.replaceFirst("^www\\.", "");
                out.add(new FreeImage(raw, raw, query, source, ""));
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** Fallback image source: SerpAPI google_images (existing behaviour). */
    private List<FreeImage> serpImages(String query, double count) {
        Object countParam = count == Math.rint(count) ? (long) count : count;
        JsonNode data = serp.search(Map.of("engine", "google_images", "q", query, "num", countParam));

        List<FreeImage> out = new ArrayList<>();
        for (JsonNode img : Json.arrOr(data, "images_results")) {
            String original = text(img, "original");
            String thumbnail = text(img, "thumbnail");
            String title = JsCompat.slice(text(img, "title"), 160);
            String source = text(img, "source");
            String link = text(img, "link");
            String url = !original.isEmpty() ? original : thumbnail;
            if (!HTTP_I.matcher(url).find()) {
                continue;
            }
            out.add(new FreeImage(
                    url,
                    HTTP_I.matcher(thumbnail).find() ? thumbnail : url,
                    title,
                    source,
                    link));
        }
        return out;
    }

    // ------------------------------------------------------------ helpers

    private static List<FreeImage> concat(List<FreeImage> a, List<FreeImage> b) {
        List<FreeImage> out = new ArrayList<>(a.size() + b.size());
        out.addAll(a);
        out.addAll(b);
        return out;
    }

    private static ObjectNode imageList(List<FreeImage> images) {
        ObjectNode res = Json.obj();
        ArrayNode arr = res.putArray("images");
        for (FreeImage img : images) {
            ObjectNode node = Json.obj();
            node.put("url", img.url());
            node.put("thumbnail", img.thumbnail());
            node.put("title", img.title());
            node.put("source", img.source());
            node.put("link", img.link());
            arr.add(node);
        }
        return res;
    }

    /** TS {@code typeof v === "string" ? v : ""}. */
    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : "";
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
