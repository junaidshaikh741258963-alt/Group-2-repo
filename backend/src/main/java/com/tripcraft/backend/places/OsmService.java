package com.tripcraft.backend.places;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Free, keyless place data from OpenStreetMap (Overpass) + Nominatim — port of
 * {@code src/lib/osm.ts}.
 *
 * <p>Used as a graceful fallback whenever SerpAPI is missing, rate-limited or
 * empty: every method returns an empty list / {@code null} on failure instead
 * of throwing, exactly like the TypeScript originals.
 *
 * <p>The TS build also wrapped these calls in the shared {@code runWithProvider}
 * circuit breaker; the Java {@code infra} package has no breaker/queue, so the
 * mirror sweep and the deadline logic below carry the whole "fail fast to the
 * next source" behaviour on their own.
 */
@Service
public class OsmService {

    static final String[] OVERPASS_ENDPOINTS = {
            // Global mirrors. Overpass rejects anonymous requests with HTTP 406, so a
            // descriptive User-Agent is required (see overpassQuery below).
            "https://overpass-api.de/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
    };
    static final String NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
    /** OSM projects reject anonymous clients (HTTP 406 / "Access denied"). */
    public static final String OSM_USER_AGENT = "AITravelPlanner/1.0 (free OpenStreetMap place data)";

    private static final Map<String, String> OSM_HEADERS = Map.of(
            "Content-Type", "application/x-www-form-urlencoded",
            "Accept", "application/json",
            "User-Agent", OSM_USER_AGENT);
    private static final Map<String, String> NOMINATIM_HEADERS = Map.of(
            "Accept", "application/json",
            "User-Agent", OSM_USER_AGENT);

    private static final Pattern P_TAG_FILTER = Pattern.compile("^\"([^\"]+)\"~\"([^\"]*)\"$");

    // ------------------------------------------------------------ overpass

    public JsonNode overpassQuery(String query) {
        return overpassQuery(query, 10000, 22000, null);
    }

    public JsonNode overpassQuery(String query, int timeoutMs, int deadlineMs) {
        return overpassQuery(query, timeoutMs, deadlineMs, null);
    }

    /**
     * Runs an Overpass QL query, trying known mirrors in order. Returns parsed
     * JSON or {@code null} when every mirror fails.
     *
     * <p>{@code deadlineMs} caps the whole sweep — RAG passes a short one so a
     * dead mirror stack can't eat the chat's retrieval budget.
     *
     * <p>{@code isFailure} marks a HTTP-200 payload that reports its own runtime
     * error (an Overpass query timeout looks exactly like a success here) as a
     * miss, so the sweep moves to the next mirror instead of handing an empty
     * result back as if it were data.
     */
    public JsonNode overpassQuery(String query, int timeoutMs, int deadlineMs, Predicate<JsonNode> isFailure) {
        try {
            long deadline = System.currentTimeMillis() + deadlineMs;
            String body = "data=" + Js.encode(query);
            for (String endpoint : OVERPASS_ENDPOINTS) {
                long left = deadline - System.currentTimeMillis();
                if (left < 1000) {
                    break;
                }
                int ms = (int) Math.min(timeoutMs, left);
                for (int attempt = 0; attempt < 2; attempt++) {
                    try {
                        Http.Raw res = Http.post(endpoint, body, OSM_HEADERS, ms);
                        if (res.status() == 429 && attempt == 0 && System.currentTimeMillis() + 2500 < deadline) {
                            // Shared public mirrors throttle bursts — back off and try once more.
                            delay(2500);
                            continue;
                        }
                        if (!res.ok()) {
                            break;
                        }
                        JsonNode data = res.json();
                        if (data != null && data.isObject()) {
                            if (isFailure != null && isFailure.test(data)) {
                                break; // bad payload → next mirror
                            }
                            return data;
                        }
                        break;
                    } catch (Exception e) {
                        break; // timeout/network → next mirror
                    }
                }
            }
            // Throwing records a breaker failure (a resolved null would not).
            throw new IllegalStateException("all Overpass mirrors failed");
        } catch (Exception e) {
            return null; // circuit open / queue timeout / all mirrors failed
        }
    }

    /** Nominatim only understands short category keywords, not phrases. */
    static String poiQueryFor(String query) {
        String q = query.toLowerCase(java.util.Locale.ROOT);
        if (find("landmark|monument|historic|heritage|castle|memorial|ruin", q)) {
            return "monument";
        }
        if (find("museum|gallery|art\\b|exhibition", q)) {
            return "museum";
        }
        if (find("things to do|activity|activities|attraction|sight|tour\\b", q)) {
            return "attractions";
        }
        if (find("cafe|coffee|tea house", q)) {
            return "cafe";
        }
        if (find("bar|pub|nightlife|cocktail", q)) {
            return "bar";
        }
        if (find("restaurant|dining|food|eat|meal", q)) {
            return "restaurant";
        }
        if (find("hotel|stay|lodging|hostel|resort", q)) {
            return "hotel";
        }
        if (find("shop|shopping|mall|store|market", q)) {
            return "mall";
        }
        if (find("park|garden|nature", q)) {
            return "park";
        }
        if (find("viewpoint|lookout|panorama", q)) {
            return "viewpoint";
        }
        return query;
    }

    private static boolean find(String regex, String q) {
        return Pattern.compile(regex).matcher(q).find();
    }

    // ---------------------------------------------------------- nominatim

    public List<OsmPoint> nominatimInViewbox(String query, double lat, double lng) {
        return nominatimInViewbox(query, lat, lng, 3, 12);
    }

    /** Category search inside a bounding box (free Nominatim fallback for Overpass). */
    public List<OsmPoint> nominatimInViewbox(String query, double lat, double lng, double radiusKm, int limit) {
        String q = poiQueryFor(query).trim();
        if (q.isEmpty() || !Double.isFinite(lat) || !Double.isFinite(lng)) {
            return List.of();
        }
        double d = Math.min(Math.max(radiusKm, 0.5), 25) / 111;
        String viewbox = Js.numStr(lng - d) + "," + Js.numStr(lat + d) + ","
                + Js.numStr(lng + d) + "," + Js.numStr(lat - d);
        try {
            String url = NOMINATIM_ENDPOINT + "?format=json&q=" + Js.encode(q)
                    + "&viewbox=" + Js.encode(viewbox) + "&bounded=1&limit=" + limit;
            Http.Raw res = Http.get(url, NOMINATIM_HEADERS, 8000);
            if (!res.ok()) {
                throw new IllegalStateException("nominatim HTTP " + res.status());
            }
            return parseNominatim(res.json(), limit, true);
        } catch (Exception e) {
            return List.of();
        }
    }

    /** Free-text Nominatim POI lookup — last resort when Overpass is down. */
    public List<OsmPoint> nominatimPois(String query, int limit) {
        String q = query == null ? "" : query.trim();
        if (q.isEmpty()) {
            return List.of();
        }
        try {
            String url = NOMINATIM_ENDPOINT + "?format=json&limit=" + limit + "&q=" + Js.encode(q);
            Http.Raw res = Http.get(url, NOMINATIM_HEADERS, 8000);
            if (!res.ok()) {
                return List.of();
            }
            return parseNominatim(res.json(), limit, false);
        } catch (Exception e) {
            return List.of();
        }
    }

    public List<OsmPoint> nominatimPois(String query) {
        return nominatimPois(query, 10);
    }

    /** Shared row mapping for the two Nominatim searches (the viewbox variant also reads {@code website}). */
    private static List<OsmPoint> parseNominatim(JsonNode data, int limit, boolean withWebsite) {
        if (data == null || !data.isArray()) {
            return List.of();
        }
        List<OsmPoint> out = new ArrayList<>();
        for (JsonNode item : data) {
            if (item == null || !item.isObject()) {
                continue;
            }
            double plat = Js.parseFloat(jsLat(item, "lat"));
            double plng = Js.parseFloat(jsLat(item, "lon"));
            String name = primaryName(item);
            if (!Double.isFinite(plat) || !Double.isFinite(plng) || name.isEmpty()) {
                continue;
            }
            String category = item.path("type").isTextual()
                    ? item.path("type").asText().replace('_', ' ')
                    : null;
            String address = item.path("display_name").isTextual()
                    ? slice(item.path("display_name").asText(), 160)
                    : null;
            String website = withWebsite && item.path("website").isTextual()
                    ? item.path("website").asText()
                    : null;
            out.add(new OsmPoint(slice(name, 140), plat, plng, category, address, null, website, null));
            if (out.size() >= limit) {
                break;
            }
        }
        return out;
    }

    /** TS {@code String(r.lat ?? "")}. */
    private static String jsLat(JsonNode item, String field) {
        JsonNode v = item.get(field);
        return v == null || v.isNull() ? "" : Js.jsString(v);
    }

    /** TS {@code typeof r.name === "string" && r.name ? r.name : String(r.display_name ?? "")}. */
    private static String primaryName(JsonNode item) {
        JsonNode name = item.get("name");
        if (name != null && name.isTextual() && !name.asText().isEmpty()) {
            return name.asText();
        }
        JsonNode display = item.get("display_name");
        if (display == null || display.isNull()) {
            return "";
        }
        return Js.jsString(display);
    }

    private static String slice(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    // -------------------------------------------------------------- query

    /** Maps a human query ("restaurants", "cafes", "tourist attractions"…) to an OSM tag filter. */
    static String filterFor(String query) {
        String q = query.toLowerCase(java.util.Locale.ROOT);
        if (find("shop|shopping|mall|store|market", q)) {
            return "\"shop\"~\"mall|clothes|gift|department_store|shoes|jewelry|electronics|books|supermarket\"";
        }
        if (find("cafe|coffee|tea house", q)) {
            return "\"amenity\"~\"cafe|ice_cream\"";
        }
        if (find("bar|pub|drink|nightlife|cocktail", q)) {
            return "\"amenity\"~\"bar|pub|biergarten|cocktail_bar\"";
        }
        if (find("restaurant|dining|food|eat|meal|cuisine", q)) {
            return "\"amenity\"~\"restaurant|fast_food\"";
        }
        if (find("hotel|stay|lodging|accommodation|hostel|resort", q)) {
            return "\"tourism\"~\"hotel|guest_house|hostel|motel|resort\"";
        }
        if (find("museum|gallery|art\\b|exhibition", q)) {
            return "\"tourism\"~\"museum|gallery|artwork\"";
        }
        if (find("landmark|monument|historic|heritage|castle|ruin|memorial|archaeolog", q)) {
            return "\"historic\"~\"monument|memorial|castle|ruins|archaeological_site|attraction\"";
        }
        if (find("things to do|thing to do|activity|activities|entertainment|adventure|fun day|family", q)) {
            return "\"tourism\"~\"attraction|theme_park|zoo|aquarium|viewpoint\"";
        }
        return "\"tourism\"~\"attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park\"";
    }

    static String categoryOf(Map<String, String> tags) {
        String raw = first(tags, "tourism", "historic", "amenity", "shop", "leisure");
        if (raw == null) {
            raw = "place";
        }
        return raw.replace('_', ' ');
    }

    static String addressOf(Map<String, String> tags) {
        String joined = joinNonBlank(" ", tags.get("addr:street"), tags.get("addr:housenumber"), tags.get("addr:city"));
        return joined.isEmpty() ? null : joined;
    }

    private static String first(Map<String, String> tags, String... keys) {
        for (String key : keys) {
            String v = tags.get(key);
            if (v != null && !v.isEmpty()) {
                return v;
            }
        }
        return null;
    }

    private static String joinNonBlank(String sep, String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p != null && !p.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append(sep);
                }
                sb.append(p);
            }
        }
        return sb.toString();
    }

    // ------------------------------------------------------------ geometry

    /** Great-circle distance between two points, in kilometres. */
    public static double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double h = Math.pow(Math.sin(dLat / 2), 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.pow(Math.sin(dLng / 2), 2);
        return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    /** Overpass elements → named points, de-duplicated by name + coordinates. */
    static List<OsmPoint> collectOverpassPoints(JsonNode elements, int collectMax) {
        List<OsmPoint> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode el : Json.elements(elements)) {
            Double lat = coordinate(el, "lat", "center", "lat");
            Double lng = coordinate(el, "lon", "center", "lon");
            JsonNode tagsNode = el.path("tags");
            if (lat == null || lng == null || !tagsNode.isObject()) {
                continue;
            }
            JsonNode nameNode = tagsNode.get("name");
            if (nameNode == null || !nameNode.isTextual() || nameNode.asText().isEmpty()) {
                continue;
            }
            String name = nameNode.asText();
            String key = name + "|" + String.format(java.util.Locale.ROOT, "%.5f", lat)
                    + "," + String.format(java.util.Locale.ROOT, "%.5f", lng);
            if (!seen.add(key)) {
                continue;
            }
            Map<String, String> tags = toStringMap(tagsNode);
            out.add(new OsmPoint(
                    slice(name, 140),
                    lat,
                    lng,
                    categoryOf(tags),
                    addressOf(tags),
                    tags.get("opening_hours"),
                    nonBlank(tags.get("website")) != null ? tags.get("website") : tags.get("contact:website"),
                    nonBlank(tags.get("phone")) != null ? tags.get("phone") : tags.get("contact:phone")));
            if (out.size() >= collectMax) {
                break;
            }
        }
        return out;
    }

    /**
     * TS {@code el.lat ?? el.center?.lat} followed by the {@code typeof ===
     * "number"} guard: a present-but-wrong-typed value does NOT fall through
     * the nullish coalescing, it simply fails the guard.
     */
    private static Double coordinate(JsonNode el, String direct, String center, String centerField) {
        JsonNode node = el.get(direct);
        if (node == null || node.isNull()) {
            node = el.path(center).path(centerField);
        }
        return node.isNumber() ? node.asDouble() : null;
    }

    private static Map<String, String> toStringMap(JsonNode tagsNode) {
        Map<String, String> tags = new LinkedHashMap<>();
        tagsNode.fields().forEachRemaining(e -> tags.put(e.getKey(),
                e.getValue().isTextual() ? e.getValue().asText() : Js.jsString(e.getValue())));
        return tags;
    }

    private static String nonBlank(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    /**
     * Folds tag conditions sharing a key into one OR regex, so unioning several
     * categories costs a single clause per key. Anything that isn't a plain
     * {@code "key"~"value"} condition passes through untouched.
     */
    static List<String> mergeTagFilters(List<String> filters) {
        Map<String, LinkedHashSet<String>> byKey = new LinkedHashMap<>();
        List<String> passthrough = new ArrayList<>();
        for (String f : new LinkedHashSet<>(filters)) {
            Matcher m = P_TAG_FILTER.matcher(f);
            if (!m.matches()) {
                passthrough.add(f);
                continue;
            }
            LinkedHashSet<String> values = byKey.computeIfAbsent(m.group(1), k -> new LinkedHashSet<>());
            for (String v : m.group(2).split("\\|", -1)) {
                if (!v.isEmpty()) {
                    values.add(v);
                }
            }
        }
        List<String> merged = new ArrayList<>();
        byKey.forEach((key, values) -> merged.add("\"" + key + "\"~\"" + String.join("|", values) + "\""));
        merged.addAll(passthrough);
        return merged;
    }

    // ---------------------------------------------------------- overpass #2

    /** Search OSM around a coordinate. Returns {@code []} on any failure/timeout. */
    public List<OsmPoint> overpassNearby(double lat, double lng, String query, double radiusKm, int limit) {
        return overpassNearby(lat, lng, query, radiusKm, limit, 10000, 22000);
    }

    /**
     * @param timeoutMs  per-mirror fetch timeout (default 10s in the TS)
     * @param deadlineMs whole-mirror-sweep deadline (default 22s in the TS);
     *                   {@code /api/places/nearby} passes 6000 to reproduce its
     *                   {@code Promise.race(delay(6000))} cap
     */
    public List<OsmPoint> overpassNearby(double lat, double lng, String query, double radiusKm, int limit,
            int timeoutMs, int deadlineMs) {
        if (!Double.isFinite(lat) || !Double.isFinite(lng)) {
            return List.of();
        }
        int radius = (int) Math.round(clampDouble(radiusKm, 0.2, 30) * 1000);
        int lim = (int) Math.min(Math.max(limit, 1), 50);
        String f = filterFor(query == null ? "" : query);
        String coord = Js.numStr(lat) + "," + Js.numStr(lng);
        String queryText = "[out:json][timeout:10];"
                + "( node[" + f + "](around:" + radius + "," + coord + ");"
                + " way[" + f + "](around:" + radius + "," + coord + "); );"
                + "out center body " + (lim * 4) + ";";
        try {
            JsonNode data = overpassQuery(queryText, timeoutMs, deadlineMs);
            if (data == null) {
                return List.of();
            }
            List<OsmPoint> out = collectOverpassPoints(Json.arrOr(data, "elements"), Math.min(lim * 4, 60));
            // Nearest first — Overpass returns rows in no useful order.
            out.sort(Comparator.comparingDouble(p -> haversineKm(lat, lng, p.lat(), p.lng())));
            return out.size() > lim ? new ArrayList<>(out.subList(0, lim)) : out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /**
     * One Overpass sweep across every anchor point along a path — this is what
     * answers "what's between my origin and destination?" without firing a query
     * per stop. All {@code queries} are unioned into a single request (tag
     * conditions that share a key are folded together first), so the whole
     * corridor costs one round trip to one mirror.
     *
     * <p>Returns points sorted nearest-anchor first; the caller decides what
     * "along the route" ordering means for its own geometry.
     */
    public List<OsmPoint> overpassAlongAnchors(List<Coord> rawAnchors, double radiusKm, List<String> queries,
            int limit, int timeoutMs, int deadlineMs) {
        List<Coord> anchors = new ArrayList<>();
        for (Coord a : rawAnchors) {
            if (anchors.size() >= 6) {
                break;
            }
            if (Double.isFinite(a.lat()) && Double.isFinite(a.lng())) {
                anchors.add(a);
            }
        }
        if (anchors.isEmpty()) {
            return List.of();
        }

        int radius = (int) Math.round(clampDouble(radiusKm, 0.2, 30) * 1000);
        int lim = (int) Math.min(Math.max(limit, 1), 200);
        List<String> filters = mergeTagFilters(queries.stream().map(OsmService::filterFor).toList());
        if (filters.isEmpty()) {
            return List.of();
        }

        // `nwr` folds node + way + relation into ONE clause. The public instances
        // are slow enough that halving the union size is often the difference
        // between a corridor query finishing and hitting Overpass's own timeout —
        // which, note, arrives as HTTP 200 with a `remark`, not as an error.
        StringBuilder clauses = new StringBuilder();
        for (Coord a : anchors) {
            for (String f : filters) {
                clauses.append(" nwr[").append(f).append("](around:").append(radius)
                        .append(",").append(Js.numStr(a.lat())).append(",").append(Js.numStr(a.lng())).append(");");
            }
        }
        String queryText = "[out:json][timeout:" + Math.max(5, Math.round(timeoutMs / 1000.0)) + "];"
                + "(" + clauses + ");out center body " + (lim * 3) + ";";

        try {
            JsonNode data = overpassQuery(queryText, timeoutMs, deadlineMs, d ->
                    // Empty + remark = the query died. Rows present = usable data even if
                    // the response was truncated, so never throw those away.
                    d.path("remark").isTextual() && Json.arrOr(d, "elements").isEmpty());
            if (data == null) {
                return List.of();
            }
            List<OsmPoint> out = collectOverpassPoints(Json.arrOr(data, "elements"), lim * 3);

            // TS keys this by the point object itself — identity, not content.
            Map<OsmPoint, Double> nearest = new java.util.IdentityHashMap<>();
            for (OsmPoint p : out) {
                double best = Double.POSITIVE_INFINITY;
                for (Coord a : anchors) {
                    best = Math.min(best, haversineKm(a.lat(), a.lng(), p.lat(), p.lng()));
                }
                nearest.put(p, best);
            }
            // Ties keep insertion order, matching the stable JS sort.
            List<OsmPoint> sorted = new ArrayList<>(out);
            sorted.sort(Comparator.comparingDouble(p -> nearest.getOrDefault(p, 0.0)));
            return sorted.size() > lim ? new ArrayList<>(sorted.subList(0, lim)) : sorted;
        } catch (Exception e) {
            return List.of();
        }
    }

    // ------------------------------------------------------------ geocode

    /** Free geocode (Nominatim) → map center, or {@code null}. */
    public Coord geocodeCenter(String query) {
        String q = query == null ? "" : query.trim();
        if (q.isEmpty()) {
            return null;
        }
        try {
            Http.Raw res = Http.get(NOMINATIM_ENDPOINT + "?format=json&limit=1&q=" + Js.encode(q),
                    NOMINATIM_HEADERS, 8000);
            if (!res.ok()) {
                throw new IllegalStateException("nominatim HTTP " + res.status());
            }
            JsonNode data = res.json();
            if (data == null || !data.isArray() || data.isEmpty()) {
                return null;
            }
            JsonNode first = data.get(0);
            double lat = Js.parseFloat(jsLat(first, "lat"));
            double lng = Js.parseFloat(jsLat(first, "lon"));
            if (!Double.isFinite(lat) || !Double.isFinite(lng)) {
                return null;
            }
            return new Coord(lat, lng);
        } catch (Exception e) {
            return null;
        }
    }

    // -------------------------------------------------------------- misc

    private static double clampDouble(double v, double lo, double hi) {
        return Math.min(Math.max(v, lo), hi);
    }

    /**
     * A bounded wait for the rate-limit pauses the TS performs with
     * {@code await new Promise(r => setTimeout(r, ms))} (Overpass 429 backoff,
     * Nominatim's one-request-per-second spacing). {@code Thread.sleep} is
     * banned in request paths, so the wait runs on the shared delayed executor
     * and the caller parks on it instead.
     */
    public static void delay(long ms) {
        if (ms <= 0) {
            return;
        }
        try {
            CompletableFuture.runAsync(() -> { }, CompletableFuture.delayedExecutor(ms, TimeUnit.MILLISECONDS))
                    .join();
        } catch (Exception e) {
            // Interrupted / shutdown — proceed without waiting.
        }
    }
}
