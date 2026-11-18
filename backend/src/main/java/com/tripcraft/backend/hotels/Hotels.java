package com.tripcraft.backend.hotels;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.places.Js;
import com.tripcraft.backend.places.OsmService;

/**
 * Port of {@code src/lib/hotels.ts} — free, keyless hotel search over
 * OpenStreetMap (Overpass), used as the fallback whenever SerpAPI is out of
 * quota (which, in this environment, is always).
 *
 * <p>Every failure path returns an empty list instead of throwing, exactly
 * like the TypeScript original.
 */
@Service
public class Hotels {

    /** Leading-integer scan matching JS {@code parseInt} for OSM's {@code stars} tag. */
    private static final Pattern JS_INT = Pattern.compile("^\\s*[+-]?\\d+");

    private final OsmService osm;

    @Autowired
    public Hotels(OsmService osm) {
        this.osm = osm;
    }

    public List<Hotel> searchHotels(double lat, double lng, double radiusKm, int limit) {
        return searchHotels(lat, lng, radiusKm, limit, null, null);
    }

    /** Same search with the {@code fast: {timeoutMs, deadlineMs}} budgets RAG passes. */
    public List<Hotel> searchHotels(double lat, double lng, double radiusKm, int limit,
            Integer timeoutMs, Integer deadlineMs) {
        String query = overpassQuery(lat, lng, radiusKm);
        try {
            JsonNode data = timeoutMs == null || deadlineMs == null
                    ? osm.overpassQuery(query)
                    : osm.overpassQuery(query, timeoutMs, deadlineMs);
            if (data == null) {
                return List.of();
            }

            List<Hotel> hotels = new ArrayList<>();
            JsonNode elements = data.get("elements");
            if (elements != null && elements.isArray()) {
                int taken = 0;
                for (JsonNode el : elements) {
                    if (taken >= limit) {
                        break;
                    }
                    taken++;
                    Hotel hotel = fromElement(el, lat, lng, hotels.size() + 1);
                    if (hotel != null) {
                        hotels.add(hotel);
                    }
                }
            }

            // Deterministic (stable) price order, like the TS sort.
            hotels.sort(Comparator.comparingInt(Hotel::pricePerNight));
            return hotels;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** The exact Overpass QL of the TS template (whitespace is ignored by Overpass). */
    static String overpassQuery(double lat, double lng, double radiusKm) {
        String around = "(around:" + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ")";
        return "[out:json][timeout:10];\n"
                + "    (\n"
                + "      node[\"tourism\"~\"hotel|motel|hostel|guest_house\"]" + around + ";\n"
                + "      way[\"tourism\"~\"hotel|motel|hostel|guest_house\"]" + around + ";\n"
                + "    );\n"
                + "    out center body 500;\n";
    }

    private static Hotel fromElement(JsonNode el, double centerLat, double centerLng, int fallbackId) {
        JsonNode tagsNode = el.get("tags");
        JsonNode tags = tagsNode != null && tagsNode.isObject() ? tagsNode : null;

        // el.lat || el.center.lat — a falsy (0 / missing) node coordinate falls
        // back to the way's center, then skips the element when still falsy.
        double hotelLat = numberOrNull(el.get("lat"));
        if (!truthy(hotelLat)) {
            JsonNode center = el.get("center");
            hotelLat = numberOrNull(center == null ? null : center.get("lat"));
        }
        double hotelLng = numberOrNull(el.get("lon"));
        if (!truthy(hotelLng)) {
            JsonNode center = el.get("center");
            hotelLng = numberOrNull(center == null ? null : center.get("lon"));
        }
        if (!truthy(hotelLat) || !truthy(hotelLng)) {
            return null;
        }

        String name = tag(tags, "name");
        if (name == null) {
            return null;
        }

        double dist = getDistance(centerLat, centerLng, hotelLat, hotelLng);

        double idValue = Js.num(el.get("id")); // Number(el.id): null -> 0, missing -> NaN
        double id = Double.isFinite(idValue) ? idValue : fallbackId;

        String address = jsJoinSpace(tag(tags, "addr:street"), tag(tags, "addr:housenumber"), tag(tags, "addr:city"));
        if (address.isEmpty()) {
            address = "Nearby";
        }

        int stars = getStarRating(tags);
        return new Hotel(
                id,
                name,
                hotelLat,
                hotelLng,
                address,
                firstNonEmpty(tag(tags, "phone"), tag(tags, "contact:phone")),
                firstNonEmpty(tag(tags, "website"), tag(tags, "contact:website")),
                stars,
                estimatePrice(stars, tags),
                "USD",
                getAmenities(tags),
                Math.round(dist * 100) / 100.0);
    }

    /** Deterministic category-based estimate (no fabricated per-request randomness). */
    static int estimatePrice(int stars, JsonNode tags) {
        int price = switch (stars) {
            case 1 -> 45;
            case 2 -> 75;
            case 3 -> 120;
            case 4 -> 200;
            case 5 -> 350;
            default -> 100;
        };

        String tourism = tag(tags, "tourism");
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

    static int getStarRating(JsonNode tags) {
        String starsTag = tag(tags, "stars");
        if (starsTag != null) {
            int s = jsParseInt(starsTag);
            if (s >= 1 && s <= 5) {
                return s;
            }
        }
        String tourism = tag(tags, "tourism");
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

    static List<String> getAmenities(JsonNode tags) {
        List<String> amenities = new ArrayList<>();
        if ("restaurant".equals(tag(tags, "amenity")) || "yes".equals(tag(tags, "food"))) {
            amenities.add("Restaurant");
        }
        if ("yes".equals(tag(tags, "wheelchair"))) {
            amenities.add("Accessible");
        }
        String internet = tag(tags, "internet_access");
        if ("yes".equals(internet) || "wlan".equals(internet)) {
            amenities.add("Free WiFi");
        }
        String parking = tag(tags, "parking");
        if ("yes".equals(parking) || "surface".equals(parking)) {
            amenities.add("Parking");
        }
        if ("yes".equals(tag(tags, "swimming_pool"))) {
            amenities.add("Pool");
        }
        if ("yes".equals(tag(tags, "gym"))) {
            amenities.add("Gym");
        }
        if ("yes".equals(tag(tags, "spa"))) {
            amenities.add("Spa");
        }
        if (amenities.isEmpty()) {
            amenities.add("WiFi");
            amenities.add("Parking");
        }
        return amenities;
    }

    static double getDistance(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371;
        double dLat = ((lat2 - lat1) * Math.PI) / 180;
        double dLon = ((lon2 - lon1) * Math.PI) / 180;
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ------------------------------------------------------------ helpers

    /** A non-empty string tag, {@code null} when absent/empty (JS truthiness). */
    private static String tag(JsonNode tags, String key) {
        if (tags == null) {
            return null;
        }
        JsonNode v = tags.get(key);
        return v != null && v.isTextual() && !v.asText().isEmpty() ? v.asText() : null;
    }

    private static String firstNonEmpty(String a, String b) {
        return a != null ? a : b;
    }

    /** {@code [...].filter(Boolean).join(" ")}. */
    private static String jsJoinSpace(String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p != null && !p.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append(' ');
                }
                sb.append(p);
            }
        }
        return sb.toString();
    }

    private static double numberOrNull(JsonNode v) {
        return v != null && v.isNumber() ? v.asDouble() : Double.NaN;
    }

    private static boolean truthy(double v) {
        return v != 0 && !Double.isNaN(v);
    }

    private static int jsParseInt(String s) {
        Matcher m = JS_INT.matcher(s);
        if (!m.find()) {
            return Integer.MIN_VALUE; // parseInt -> NaN -> never in 1..5
        }
        try {
            return Integer.parseInt(m.group().replaceAll("\\s", ""));
        } catch (NumberFormatException e) {
            return Integer.MIN_VALUE;
        }
    }
}
