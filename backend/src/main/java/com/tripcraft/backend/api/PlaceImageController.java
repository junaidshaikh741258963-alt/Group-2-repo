package com.tripcraft.backend.api;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.hotels.FreeImages;
import com.tripcraft.backend.hotels.FreeImages.FreeImage;
import com.tripcraft.backend.hotels.JsCompat;
import com.tripcraft.backend.hotels.PlaceQuery;
import com.tripcraft.backend.hotels.PlaceQuery.PlaceContext;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/app/api/place-image/route.ts} — the single place image
 * for cards/popups.
 *
 * <p>Priority (SerpAPI last, one call max):
 * <ol>
 *   <li>Server memory cache (kept indefinitely, evicted only by cap);</li>
 *   <li>free sources: Wikimedia Commons + Openverse (keyless);</li>
 *   <li>SerpAPI google_images (num=1) — ONLY for restaurant / hotel / cafe /
 *       attraction. NEVER for city / landmark (Paris, Eiffel Tower, …);</li>
 *   <li>placeholder (no external fetch).</li>
 * </ol>
 *
 * <p>SerpAPI is out of quota in this environment, so the free sources (and the
 * placeholder) are what actually run — an empty result resolves to the
 * placeholder tile, never an error.
 */
@RestController
@RequestMapping("/api/place-image")
public class PlaceImageController {

    private static final Logger log = LoggerFactory.getLogger(PlaceImageController.class);

    private static final int CACHE_MAX = 2000;
    private static final Set<String> SERP_ELIGIBLE = Set.of("restaurant", "hotel", "cafe", "attraction");
    private static final Set<String> KNOWN_CATEGORIES =
            Set.of("city", "landmark", "restaurant", "hotel", "cafe", "attraction");
    private static final Set<String> NO_CITY_TOKENS = Set.of();
    private static final java.util.regex.Pattern HTTP_I =
            java.util.regex.Pattern.compile("^https?://", java.util.regex.Pattern.CASE_INSENSITIVE);

    /** One resolved image: {@code image} may be null (= show the placeholder). */
    private record ImgResult(String image, String source) {
    }

    private record CacheEntry(ImgResult result) {
    }

    private final Map<String, CacheEntry> cache = new LinkedHashMap<>();
    private final Map<String, CompletableFuture<ImgResult>> inflight = new LinkedHashMap<>();

    private final SerpApiService serp;

    @Autowired
    public PlaceImageController(SerpApiService serp) {
        this.serp = serp;
    }

    @PostMapping
    public ResponseEntity<?> placeImage(@RequestBody(required = false) String raw) {
        try {
            JsonNode parsed = Json.parseOrNull(raw);
            JsonNode body = parsed == null ? Json.obj() : parsed; // TS: req.json().catch(() => ({}))
            String name = JsCompat.slice(JsCompat.jsTrim(text(body, "name")), 120);
            if (name.isEmpty()) {
                return ResponseEntity.badRequest().body(error("name required"));
            }
            String city = JsCompat.slice(JsCompat.jsTrim(text(body, "city")), 120);
            Double lat = body.get("lat") != null && body.get("lat").isNumber() ? body.get("lat").asDouble() : null;
            Double lng = body.get("lng") != null && body.get("lng").isNumber() ? body.get("lng").asDouble() : null;
            String rawCategory = JsCompat.jsLowerCase(text(body, "category"));
            if (rawCategory.isEmpty()) {
                rawCategory = "attraction";
            }
            String category = KNOWN_CATEGORIES.contains(rawCategory) ? rawCategory : "attraction";

            String key = cacheKey(name, city, category);
            ImgResult hit;
            synchronized (cache) {
                CacheEntry entry = cache.get(key);
                hit = entry == null ? null : entry.result();
            }
            if (hit != null) {
                log.info("[img] \"{}\" <- cache (was {})", name, hit.source());
                return ResponseEntity.ok(wire(hit));
            }

            CompletableFuture<ImgResult> pending;
            synchronized (inflight) {
                pending = inflight.get(key);
            }
            if (pending != null) {
                ImgResult result = pending.join();
                return ResponseEntity.ok(wire(result));
            }

            CompletableFuture<ImgResult> task;
            synchronized (inflight) {
                task = inflight.computeIfAbsent(key, k -> CompletableFuture.supplyAsync(() -> {
                    ImgResult result;
                    try {
                        result = resolveImage(name, city, category, lat, lng);
                        log.info("[img] \"{}\" <- {}", name, result.source());
                        store(key, result);
                    } catch (Exception e) {
                        result = new ImgResult(null, "placeholder");
                        store(key, result);
                    } finally {
                        synchronized (inflight) {
                            inflight.remove(k);
                        }
                    }
                    return result;
                }));
            }
            ImgResult result = task.join();
            return ResponseEntity.ok(wire(result));
        } catch (Exception err) {
            log.error("Place image error:", err);
            return ResponseEntity.ok(wire(new ImgResult(null, "placeholder")));
        }
    }

    // ------------------------------------------------------------ resolve

    private ImgResult resolveImage(String name, String city, String category, Double lat, Double lng) {
        PlaceContext ctx = PlaceQuery.resolvePlaceContext(name, lat, lng, city.isEmpty() ? null : city, null);
        String query = ctx.query();

        CompletableFuture<List<FreeImage>> commonsFuture =
                CompletableFuture.supplyAsync(() -> FreeImages.commonsImages(query));
        List<FreeImage> openverse = FreeImages.openverseImages(query);
        List<FreeImage> commons = commonsFuture.join();
        List<FreeImage> free = new ArrayList<>(commons.size() + openverse.size());
        free.addAll(commons);
        free.addAll(openverse);

        // Prefer results that mention the place or its city ("Le Marais" must not
        // resolve to a countryside wetland).
        FreeImage validated = firstMentioning(free, ctx.placeTokens(), ctx.cityTokens());
        if (validated == null) {
            validated = firstMentioning(free, ctx.placeTokens(), NO_CITY_TOKENS);
        }
        FreeImage picked = validated != null ? validated : (free.isEmpty() ? null : free.get(0));
        if (picked != null) {
            String image = !picked.thumbnail().isEmpty() ? picked.thumbnail() : picked.url();
            return new ImgResult(image, "wikimedia commons".equals(picked.source()) ? "commons" : "openverse");
        }

        // SerpAPI only where free sources can't cover the category.
        if (SERP_ELIGIBLE.contains(category)) {
            try {
                JsonNode data = serp.search(Map.of("engine", "google_images", "q", query, "num", 1));
                JsonNode results = data.get("images_results");
                JsonNode first = results != null && results.isArray() && !results.isEmpty() ? results.get(0) : null;
                String original = text(first, "original");
                String thumbnail = text(first, "thumbnail");
                String url = !original.isEmpty() ? original : thumbnail;
                if (!url.isEmpty() && HTTP_I.matcher(url).find()) {
                    return new ImgResult(url, "serpapi");
                }
            } catch (Exception e) {
                // fall through to placeholder
            }
        }

        return new ImgResult(null, "placeholder");
    }

    private static FreeImage firstMentioning(List<FreeImage> free, Set<String> placeTokens, Set<String> cityTokens) {
        for (FreeImage f : free) {
            if (PlaceQuery.titleMentions(f.title(), placeTokens, cityTokens)) {
                return f;
            }
        }
        return null;
    }

    // ------------------------------------------------------------ helpers

    private static String cacheKey(String name, String city, String category) {
        return category + "|" + JsCompat.jsLowerCase(name.trim()) + "|" + JsCompat.jsLowerCase(city.trim());
    }

    private void store(String key, ImgResult value) {
        synchronized (cache) {
            if (cache.size() >= CACHE_MAX) {
                Iterator<String> oldest = cache.keySet().iterator();
                if (oldest.hasNext()) {
                    oldest.next();
                    oldest.remove();
                }
            }
            cache.put(key, new CacheEntry(value));
        }
    }

    /** {@code {...result, placeholder: PLACEHOLDER_IMAGE}} — image null stays null. */
    private static ObjectNode wire(ImgResult result) {
        ObjectNode res = Json.obj();
        if (result.image() == null) {
            res.putNull("image");
        } else {
            res.put("image", result.image());
        }
        res.put("source", result.source());
        res.put("placeholder", FreeImages.PLACEHOLDER_IMAGE);
        return res;
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : "";
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }
}
