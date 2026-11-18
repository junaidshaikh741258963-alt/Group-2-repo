package com.tripcraft.backend.api;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Js;
import com.tripcraft.backend.places.OsmPoint;
import com.tripcraft.backend.places.OsmService;

/**
 * Port of {@code src/app/api/places/nearby/route.ts} — the "what's around me?"
 * panel. Free sources first (Overpass, capped at 6s, then Nominatim), and only
 * then SerpAPI for the ratings/thumbnails neither of the free ones carry.
 */
@RestController
@RequestMapping("/api/places")
public class PlacesNearbyController {

    private static final Logger log = LoggerFactory.getLogger(PlacesNearbyController.class);

    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    /** The TS races Overpass against a 6s timer so a dead mirror can't stall the tab. */
    private static final int OVERPASS_TIMEOUT_MS = 10_000;
    private static final int OVERPASS_DEADLINE_MS = 6_000;

    private final OsmService osm;
    private final SerpApiService serp;

    public PlacesNearbyController(OsmService osm, SerpApiService serp) {
        this.osm = osm;
        this.serp = serp;
    }

    @PostMapping("/nearby")
    public ResponseEntity<?> nearby(@RequestBody(required = false) String raw) {
        try {
            // TS: `await req.json().catch(() => ({}))` — bad JSON degrades to {},
            // but a parsed `null` still throws when the route destructures it.
            JsonNode parsed = Json.parseOrNull(raw);
            JsonNode body = parsed == null || parsed.isMissingNode() ? Json.obj() : parsed;
            if (body.isNull()) {
                throw new IllegalArgumentException("Cannot destructure property of null");
            }

            JsonNode latNode = body.get("lat");
            JsonNode lngNode = body.get("lng");
            double la = latNode != null && latNode.isNumber()
                    ? latNode.asDouble()
                    : Js.parseFloat(Js.jsString(latNode));
            double lo = lngNode != null && lngNode.isNumber()
                    ? lngNode.asDouble()
                    : Js.parseFloat(Js.jsString(lngNode));
            JsonNode qNode = body.get("q");
            String query = qNode == null || qNode.isNull() ? "restaurants" : Js.jsString(qNode).trim();
            if (query.isEmpty()) {
                query = "restaurants";
            }
            if (!Double.isFinite(la) || !Double.isFinite(lo)
                    || la < -90 || la > 90 || lo < -180 || lo > 180) {
                return ResponseEntity.badRequest().body(error("lat/lng required"));
            }

            JsonNode countNode = body.get("count");
            int limit = countNode != null && countNode.isNumber()
                    ? (int) Math.min(Math.max(countNode.asDouble(), 1), 12)
                    : 8;

            List<ObjectNode> places = new ArrayList<>();
            Set<String> seen = new LinkedHashSet<>();

            // 1) Free, keyless source first: OpenStreetMap (Overpass).
            List<OsmPoint> osmHits = osm.overpassNearby(la, lo, query, 3, limit,
                    OVERPASS_TIMEOUT_MS, OVERPASS_DEADLINE_MS);
            for (OsmPoint p : osmHits) {
                ObjectNode o = Json.obj();
                o.put("name", p.name());
                Json.putIfPresent(o, "type", p.category());
                Json.putIfPresent(o, "address", p.address());
                Json.putIfPresent(o, "openState", p.openingHours());
                Js.putNum(o, "lat", p.lat());
                Js.putNum(o, "lng", p.lng());
                places.add(o);
                seen.add(nameKey(p.name()));
            }

            // 2) Still short → free Nominatim search inside the same area.
            if (places.size() < limit) {
                for (OsmPoint p : osm.nominatimInViewbox(query, la, lo, 3, limit)) {
                    if (places.size() >= limit) {
                        break;
                    }
                    String key = nameKey(p.name());
                    if (key.isEmpty() || seen.contains(key)) {
                        continue;
                    }
                    seen.add(key);
                    ObjectNode o = Json.obj();
                    o.put("name", p.name());
                    Json.putIfPresent(o, "type", p.category());
                    Json.putIfPresent(o, "address", p.address());
                    Js.putNum(o, "lat", p.lat());
                    Js.putNum(o, "lng", p.lng());
                    places.add(o);
                }
            }

            // 3) Top up with SerpAPI (ratings, price, thumbnails) when free data is short.
            if (places.size() < limit) {
                Map<String, Object> params = Map.of(
                        "engine", "google_maps",
                        "q", query,
                        "type", "search",
                        "ll", "@" + toFixed(la, 6) + "," + toFixed(lo, 6) + ",14z",
                        "nearby", "1");
                JsonNode data = serp.search(params);
                JsonNode localResults = data == null ? null : data.get("local_results");
                if (localResults != null && localResults.isArray()) {
                    for (JsonNode p : localResults) {
                        if (places.size() >= limit) {
                            break;
                        }
                        String name = Js.str(p.get("title"), 120);
                        if (name == null) {
                            continue;
                        }
                        String key = name.toLowerCase(Locale.ROOT);
                        if (seen.contains(key)) {
                            continue;
                        }
                        JsonNode gps = p.get("gps_coordinates");
                        Double plat = Js.finite(gps == null ? null : gps.get("latitude"));
                        Double plng = Js.finite(gps == null ? null : gps.get("longitude"));
                        String thumbnail = Js.str(p.get("thumbnail"), 600);
                        String link = Js.str(p.get("website"), 600);
                        seen.add(key);

                        ObjectNode o = Json.obj();
                        o.put("name", name);
                        putNumIfPresent(o, "rating", Js.finite(p.get("rating")));
                        putNumIfPresent(o, "reviews", Js.finite(p.get("reviews")));
                        putStrIfPresent(o, "type", Js.str(p.get("type"), 80));
                        putStrIfPresent(o, "price", Js.str(p.get("price"), 24));
                        JsonNode hours = p.get("open_state");
                        if (hours == null || hours.isNull()) {
                            hours = p.get("hours");
                        }
                        putStrIfPresent(o, "openState", Js.str(hours, 80));
                        putStrIfPresent(o, "address", Js.str(p.get("address"), 160));
                        if (thumbnail != null && HTTP_URL.matcher(thumbnail).find()) {
                            o.put("thumbnail", thumbnail);
                        }
                        if (plat != null) {
                            Js.putNum(o, "lat", plat);
                        }
                        if (plng != null) {
                            Js.putNum(o, "lng", plng);
                        }
                        if (link != null && HTTP_URL.matcher(link).find()) {
                            o.put("link", link);
                        }
                        places.add(o);
                    }
                }
            }

            ObjectNode res = Json.obj();
            ArrayNode arr = res.putArray("places");
            for (int i = 0; i < places.size() && i < limit; i++) {
                arr.add(places.get(i));
            }
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Nearby places error:", err);
            ObjectNode res = Json.obj();
            res.putArray("places");
            return ResponseEntity.ok(res);
        }
    }

    // -------------------------------------------------------------- helpers

    private static String nameKey(String name) {
        return name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
    }

    /** {@code Number.prototype.toFixed()} — shortest decimal, half away from zero. */
    static String toFixed(double v, int digits) {
        return java.math.BigDecimal.valueOf(v)
                .setScale(digits, java.math.RoundingMode.HALF_UP)
                .toPlainString();
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }

    private static void putNumIfPresent(ObjectNode node, String field, Double value) {
        if (value != null) {
            Js.putNum(node, field, value);
        }
    }

    private static void putStrIfPresent(ObjectNode node, String field, String value) {
        if (value != null) {
            node.put(field, value);
        }
    }
}
