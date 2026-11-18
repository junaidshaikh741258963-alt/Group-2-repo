package com.tripcraft.backend.rag.retrievers;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Free, keyless place data from OpenStreetMap (Overpass) + Nominatim — the
 * RAG-sized slice of {@code src/lib/osm.ts} plus {@code searchHotels} from
 * {@code src/lib/hotels.ts}. Used as the graceful fallback whenever SerpAPI is
 * missing, rate-limited, or empty; every call returns {@code []} on failure.
 */
final class Osm {

    private Osm() {
    }

    /** OSM projects reject anonymous clients (HTTP 406 / "Access denied"). */
    static final String OSM_USER_AGENT = "AITravelPlanner/1.0 (free OpenStreetMap place data)";

    private static final String NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
    private static final int NOMINATIM_TIMEOUT_MS = 8_000;

    /** Global mirrors, tried in order. */
    private static final List<String> OVERPASS_ENDPOINTS = List.of(
            "https://overpass-api.de/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter");

    private static final Map<String, String> NOMINATIM_HEADERS = Map.of(
            "Accept", "application/json",
            "User-Agent", OSM_USER_AGENT);

    /** A named OSM point. */
    record Point(String name, double lat, double lng, String category,
                 String address, String openingHours) {
    }

    /** A geocoded centre. */
    record Geo(double lat, double lng) {
    }

    /** A hotel listed in OSM. */
    record OsHotel(String name, int stars, String address) {
    }

    // ------------------------------------------------------------- nominatim

    /** Free geocode (Nominatim) → map centre, or {@code null}. */
    static Geo geocodeCenter(String query) {
        String q = query == null ? "" : query.trim();
        if (q.isEmpty()) {
            return null;
        }
        try {
            String url = NOMINATIM_ENDPOINT + "?format=json&limit=1&q=" + encode(q);
            Http.Raw raw = Http.get(url, NOMINATIM_HEADERS, NOMINATIM_TIMEOUT_MS);
            if (!raw.ok()) {
                return null;
            }
            JsonNode data = raw.json();
            if (data == null || !data.isArray() || data.size() == 0) {
                return null;
            }
            double lat = parseDouble(data.get(0).path("lat").asText(""));
            double lng = parseDouble(data.get(0).path("lon").asText(""));
            if (Double.isNaN(lat) || Double.isNaN(lng)) {
                return null;
            }
            return new Geo(lat, lng);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The agent-side geocode variant ({@code src/lib/agent/weather.ts}). */
    static Geo geocodePlace(String place) {
        String q = place == null ? "" : place.trim();
        if (q.isEmpty()) {
            return null;
        }
        try {
            String url = "https://nominatim.openstreetmap.org/search?format=json&q=" + encode(q) + "&limit=1";
            Http.Raw raw = Http.get(url, Map.of("User-Agent", "TripCraftAI/1.0"), NOMINATIM_TIMEOUT_MS);
            if (!raw.ok()) {
                return null;
            }
            JsonNode data = raw.json();
            if (data == null || !data.isArray() || data.size() == 0) {
                return null;
            }
            double lat = parseDouble(data.get(0).path("lat").asText(""));
            double lng = parseDouble(data.get(0).path("lon").asText(""));
            if (Double.isNaN(lat) || Double.isNaN(lng)) {
                return null;
            }
            return new Geo(lat, lng);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Nominatim only understands short category keywords, not phrases. */
    private static final Pattern POI_MONUMENT = Pattern.compile("landmark|monument|historic|heritage|castle|memorial|ruin");
    private static final Pattern POI_MUSEUM = Pattern.compile("museum|gallery|art\\b|exhibition");
    private static final Pattern POI_ATTRACTIONS = Pattern.compile("things to do|activity|activities|attraction|sight|tour\\b");
    private static final Pattern POI_CAFE = Pattern.compile("cafe|coffee|tea house");
    private static final Pattern POI_BAR = Pattern.compile("bar|pub|nightlife|cocktail");
    private static final Pattern POI_RESTAURANT = Pattern.compile("restaurant|dining|food|eat|meal");
    private static final Pattern POI_HOTEL = Pattern.compile("hotel|stay|lodging|hostel|resort");
    private static final Pattern POI_MALL = Pattern.compile("shop|shopping|mall|store|market");
    private static final Pattern POI_PARK = Pattern.compile("park|garden|nature");
    private static final Pattern POI_VIEWPOINT = Pattern.compile("viewpoint|lookout|panorama");

    private static String poiQueryFor(String query) {
        String q = query.toLowerCase(java.util.Locale.ROOT);
        if (POI_MONUMENT.matcher(q).find()) {
            return "monument";
        }
        if (POI_MUSEUM.matcher(q).find()) {
            return "museum";
        }
        if (POI_ATTRACTIONS.matcher(q).find()) {
            return "attractions";
        }
        if (POI_CAFE.matcher(q).find()) {
            return "cafe";
        }
        if (POI_BAR.matcher(q).find()) {
            return "bar";
        }
        if (POI_RESTAURANT.matcher(q).find()) {
            return "restaurant";
        }
        if (POI_HOTEL.matcher(q).find()) {
            return "hotel";
        }
        if (POI_MALL.matcher(q).find()) {
            return "mall";
        }
        if (POI_PARK.matcher(q).find()) {
            return "park";
        }
        if (POI_VIEWPOINT.matcher(q).find()) {
            return "viewpoint";
        }
        return query;
    }

    /** Category search inside a bounding box (free fallback for Overpass). */
    static List<Point> nominatimInViewbox(String query, double lat, double lng, double radiusKm, int limit) {
        String q = poiQueryFor(query).trim();
        if (q.isEmpty() || Double.isNaN(lat) || Double.isNaN(lng)) {
            return List.of();
        }
        try {
            double d = Math.min(Math.max(radiusKm, 0.5), 25) / 111;
            String viewbox = (lng - d) + "," + (lat + d) + "," + (lng + d) + "," + (lat - d);
            String url = NOMINATIM_ENDPOINT
                    + "?format=json&q=" + encode(q)
                    + "&viewbox=" + encode(viewbox)
                    + "&bounded=1&limit=" + limit;
            Http.Raw raw = Http.get(url, NOMINATIM_HEADERS, NOMINATIM_TIMEOUT_MS);
            if (!raw.ok()) {
                return List.of();
            }
            JsonNode data = raw.json();
            if (data == null || !data.isArray()) {
                return List.of();
            }
            List<Point> out = new ArrayList<>();
            for (JsonNode item : data) {
                if (item == null || !item.isObject()) {
                    continue;
                }
                double plat = parseDouble(item.path("lat").asText(""));
                double plng = parseDouble(item.path("lon").asText(""));
                String name = item.path("name").isTextual() && !item.path("name").asText("").isEmpty()
                        ? item.path("name").asText()
                        : item.path("display_name").asText("");
                if (Double.isNaN(plat) || Double.isNaN(plng) || name.isEmpty()) {
                    continue;
                }
                String category = item.path("type").isTextual()
                        ? item.path("type").asText().replace('_', ' ') : null;
                String address = item.path("display_name").isTextual()
                        ? item.path("display_name").asText().substring(0,
                        Math.min(item.path("display_name").asText().length(), 160))
                        : null;
                out.add(new Point(name.substring(0, Math.min(name.length(), 140)),
                        plat, plng, category, address, null));
                if (out.size() >= limit) {
                    break;
                }
            }
            return out;
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    // ------------------------------------------------------------- overpass

    /**
     * Runs an Overpass QL query, trying known mirrors in order, bounded by a
     * whole-sweep {@code deadlineMs} so a dead mirror stack can't eat the
     * retrieval budget. Returns {@code null} when every mirror fails.
     */
    static JsonNode overpassQuery(String query, int timeoutMs, int deadlineMs) {
        long deadline = System.currentTimeMillis() + deadlineMs;
        for (String endpoint : OVERPASS_ENDPOINTS) {
            long left = deadline - System.currentTimeMillis();
            if (left < 1000) {
                break;
            }
            int ms = (int) Math.min(timeoutMs, left);
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    String url = endpoint + "?data=" + encode(query);
                    Http.Raw res = Http.get(url, Map.of(
                            "Accept", "application/json",
                            "User-Agent", OSM_USER_AGENT), ms);
                    if (res.status() == 429 && attempt == 0
                            && System.currentTimeMillis() + 2500 < deadline) {
                        // Shared public mirrors throttle bursts — back off once.
                        // (No Thread.sleep in request paths: retry immediately.)
                        continue;
                    }
                    if (!res.ok()) {
                        break;
                    }
                    JsonNode data = res.json();
                    if (data != null && data.isObject()) {
                        return data;
                    }
                    break;
                } catch (RuntimeException e) {
                    break; // timeout/network → next mirror
                }
            }
        }
        return null; // all mirrors failed
    }

    private static final Pattern FILT_SHOP = Pattern.compile("shop|shopping|mall|store|market");
    private static final Pattern FILT_CAFE = Pattern.compile("cafe|coffee|tea house");
    private static final Pattern FILT_BAR = Pattern.compile("bar|pub|drink|nightlife|cocktail");
    private static final Pattern FILT_FOOD = Pattern.compile("restaurant|dining|food|eat|meal|cuisine");
    private static final Pattern FILT_HOTEL = Pattern.compile("hotel|stay|lodging|accommodation|hostel|resort");
    private static final Pattern FILT_MUSEUM = Pattern.compile("museum|gallery|art\\b|exhibition");
    private static final Pattern FILT_LANDMARK =
            Pattern.compile("landmark|monument|historic|heritage|castle|ruin|memorial|archaeolog");
    private static final Pattern FILT_THINGS =
            Pattern.compile("things to do|thing to do|activity|activities|entertainment|adventure|fun day|family");

    /** Maps a human query ("restaurants", "cafes"…) to an OSM tag filter. */
    private static String filterFor(String query) {
        String q = query.toLowerCase(java.util.Locale.ROOT);
        if (FILT_SHOP.matcher(q).find()) {
            return "\"shop\"~\"mall|clothes|gift|department_store|shoes|jewelry|electronics|books|supermarket\"";
        }
        if (FILT_CAFE.matcher(q).find()) {
            return "\"amenity\"~\"cafe|ice_cream\"";
        }
        if (FILT_BAR.matcher(q).find()) {
            return "\"amenity\"~\"bar|pub|biergarten|cocktail_bar\"";
        }
        if (FILT_FOOD.matcher(q).find()) {
            return "\"amenity\"~\"restaurant|fast_food\"";
        }
        if (FILT_HOTEL.matcher(q).find()) {
            return "\"tourism\"~\"hotel|guest_house|hostel|motel|resort\"";
        }
        if (FILT_MUSEUM.matcher(q).find()) {
            return "\"tourism\"~\"museum|gallery|artwork\"";
        }
        if (FILT_LANDMARK.matcher(q).find()) {
            return "\"historic\"~\"monument|memorial|castle|ruins|archaeological_site|attraction\"";
        }
        if (FILT_THINGS.matcher(q).find()) {
            return "\"tourism\"~\"attraction|theme_park|zoo|aquarium|viewpoint\"";
        }
        return "\"tourism\"~\"attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park\"";
    }

    private static String categoryOf(Map<String, String> tags) {
        String raw = firstNonEmpty(tags, "tourism", "historic", "amenity", "shop", "leisure");
        if (raw == null) {
            raw = "place";
        }
        return raw.replace('_', ' ');
    }

    private static String addressOf(Map<String, String> tags) {
        String street = tags.get("addr:street");
        String house = tags.get("addr:housenumber");
        String city = tags.get("addr:city");
        StringBuilder joined = new StringBuilder();
        for (String part : new String[]{street, house, city}) {
            if (part != null && !part.isEmpty()) {
                if (joined.length() > 0) {
                    joined.append(' ');
                }
                joined.append(part);
            }
        }
        return joined.length() == 0 ? null : joined.toString();
    }

    private static String firstNonEmpty(Map<String, String> tags, String... keys) {
        for (String key : keys) {
            String value = tags.get(key);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        }
        return null;
    }

    /** Overpass elements → named points, de-duplicated by name + coordinates. */
    private static List<Point> collectOverpassPoints(JsonNode elements, int collectMax) {
        List<Point> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (JsonNode el : Json.elements(elements)) {
            Double lat = coord(el, "lat");
            Double lng = coord(el, "lon");
            if (lat == null || lng == null || !el.has("tags")) {
                continue;
            }
            JsonNode tagsNode = el.get("tags");            String name = tagsNode.path("name").asText("");
            if (name.isEmpty()) {
                continue;
            }
            Map<String, String> tags = toStringMap(tagsNode);
            String key = name + "|" + String.format(java.util.Locale.ROOT, "%.5f", lat)
                    + "," + String.format(java.util.Locale.ROOT, "%.5f", lng);
            if (!seen.add(key)) {
                continue;
            }
            out.add(new Point(name.substring(0, Math.min(name.length(), 140)),
                    lat, lng, categoryOf(tags), addressOf(tags), tags.get("opening_hours")));
            if (out.size() >= collectMax) {
                break;
            }
        }
        return out;
    }

    /** TS {@code el.lat ?? el.center?.lat} with the {@code typeof === "number"} guard. */
    private static Double coord(JsonNode el, String field) {
        if (el.has(field) && el.get(field).isNumber()) {
            return el.get(field).asDouble();
        }
        JsonNode center = el.get("center");
        if (center != null && center.has(field) && center.get(field).isNumber()) {
            return center.get(field).asDouble();
        }
        return null;
    }

    /** TS {@code el.lat || el.center?.lat} — truthy check, so 0 is rejected. */
    private static Double truthyCoord(JsonNode el, String field) {
        Double value = coord(el, field);
        return value == null || value == 0 ? null : value;
    }

    private static Map<String, String> toStringMap(JsonNode node) {
        Map<String, String> map = new LinkedHashMap<>();
        if (node != null && node.isObject()) {
            node.properties().forEach(entry -> {
                if (entry.getValue().isTextual()) {
                    map.put(entry.getKey(), entry.getValue().asText());
                } else if (!entry.getValue().isNull()) {
                    map.put(entry.getKey(), entry.getValue().asText());
                }
            });
        }
        return map;
    }

    /** Search OSM around a coordinate. Returns {@code []} on any failure. */
    static List<Point> overpassNearby(double lat, double lng, String query,
                                      double radiusKm, int limit, int timeoutMs, int deadlineMs) {
        if (Double.isNaN(lat) || Double.isNaN(lng)) {
            return List.of();
        }
        int radius = (int) Math.round(Math.min(Math.max(radiusKm, 0.2), 30) * 1000);
        int capped = Math.min(Math.max(limit, 1), 50);
        String f = filterFor(query == null ? "" : query);
        String overpassQl = "[out:json][timeout:10];"
                + "( node[" + f + "](around:" + radius + "," + lat + "," + lng + ");"
                + " way[" + f + "](around:" + radius + "," + lat + "," + lng + "); );"
                + "out center body " + (capped * 4) + ";";

        try {
            JsonNode data = overpassQuery(overpassQl, timeoutMs, deadlineMs);
            if (data == null) {
                return List.of();
            }
            List<Point> out = collectOverpassPoints(data.get("elements"),
                    Math.min(capped * 4, 60));
            // Nearest first — Overpass returns rows in no useful order.
            out.sort((a, b) -> Double.compare(
                    haversineKm(lat, lng, a.lat(), a.lng()),
                    haversineKm(lat, lng, b.lat(), b.lng())));
            return out.size() > capped ? new ArrayList<>(out.subList(0, capped)) : out;
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    /** Great-circle distance between two points, in kilometres. */
    static double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double toRad = Math.PI / 180;
        double dLat = (lat2 - lat1) * toRad;
        double dLng = (lng2 - lng1) * toRad;
        double h = Math.pow(Math.sin(dLat / 2), 2)
                + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.pow(Math.sin(dLng / 2), 2);
        return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    // --------------------------------------------------------------- hotels

    private static int estimatePrice(int stars, Map<String, String> tags) {
        Map<Integer, Integer> basePrices = Map.of(1, 45, 2, 75, 3, 120, 4, 200, 5, 350);
        int price = basePrices.getOrDefault(stars, 100);
        String tourism = tags.get("tourism");
        if ("hostel".equals(tourism)) {
            price = 35;
        }
        if ("motel".equals(tourism)) {
            price = 65;
        }
        if ("guest_house".equals(tourism)) {
            price = 85;
        }
        return price;
    }

    private static int getStarRating(Map<String, String> tags) {
        String raw = tags.get("stars");
        if (raw != null) {
            try {
                int s = Integer.parseInt(raw.trim());
                if (s >= 1 && s <= 5) {
                    return s;
                }
            } catch (NumberFormatException ignored) {
                // fall through to the tag-based defaults
            }
        }
        String tourism = tags.get("tourism");
        if ("hostel".equals(tourism)) {
            return 1;
        }
        if ("motel".equals(tourism)) {
            return 2;
        }
        if ("guest_house".equals(tourism)) {
            return 3;
        }
        return 3;
    }

    /**
     * Hotels near a coordinate from Overpass — the RAG slice of
     * {@code searchHotels} in {@code src/lib/hotels.ts} (nearest/cheapest
     * ordering preserved; OSM has no real prices, only the estimate used for
     * sorting).
     */
    static List<OsHotel> searchHotels(double lat, double lng, double radiusKm, int limit,
                                      int timeoutMs, int deadlineMs) {
        long radius = Math.round(Math.min(Math.max(radiusKm, 0.2), 30) * 1000);
        String query = "[out:json][timeout:10];"
                + "( node[\"tourism\"~\"hotel|motel|hostel|guest_house\"](around:"
                + radius + "," + lat + "," + lng + ");"
                + " way[\"tourism\"~\"hotel|motel|hostel|guest_house\"](around:"
                + radius + "," + lat + "," + lng + "); );"
                + "out center body 500;";

        try {
            JsonNode data = overpassQuery(query, timeoutMs, deadlineMs);
            if (data == null) {
                return List.of();
            }
            List<OsHotel> hotels = new ArrayList<>();
            List<Integer> prices = new ArrayList<>();
            int index = 0;
            for (JsonNode el : Json.elements(data.get("elements"))) {
                if (index >= limit) {
                    break;
                }
                index++;
                Map<String, String> tags = toStringMap(el.path("tags"));
                Double hotelLat = truthyCoord(el, "lat");
                Double hotelLng = truthyCoord(el, "lon");
                if (hotelLat == null || hotelLng == null) {
                    continue;
                }
                String name = tags.get("name");
                if (name == null || name.isEmpty()) {
                    continue;
                }
                String street = tags.get("addr:street");
                String house = tags.get("addr:housenumber");
                String city = tags.get("addr:city");
                StringBuilder address = new StringBuilder();
                for (String part : new String[]{street, house, city}) {
                    if (part != null && !part.isEmpty()) {
                        if (address.length() > 0) {
                            address.append(' ');
                        }
                        address.append(part);
                    }
                }
                int stars = getStarRating(tags);
                hotels.add(new OsHotel(name, stars,
                        address.length() == 0 ? "Nearby" : address.toString()));
                prices.add(estimatePrice(stars, tags));
            }
            // Sort by estimated nightly price, ascending (JS stable sort).
            List<Integer> order = new ArrayList<>();
            for (int i = 0; i < hotels.size(); i++) {
                order.add(i);
            }
            order.sort((a, b) -> Integer.compare(prices.get(a), prices.get(b)));
            List<OsHotel> sorted = new ArrayList<>();
            for (int i : order) {
                sorted.add(hotels.get(i));
            }
            return sorted;
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    // -------------------------------------------------------------- helpers

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static double parseDouble(String value) {
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }
}
