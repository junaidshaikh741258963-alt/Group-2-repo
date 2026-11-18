package com.tripcraft.backend.agentlib;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.OsmService;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/lib/agent/hotels.ts} — Overpass hotel search with star /
 * price / amenity estimation for the agent prompt.
 */
@Service
public class HotelsTool {

    private final OsmService osm;

    public HotelsTool(OsmService osm) {
        this.osm = osm;
    }

    public record HotelResult(
            long id,
            String name,
            double lat,
            double lng,
            String address,
            int stars,
            double pricePerNight,
            String currency,
            List<String> amenities,
            double distanceFromCenter,
            String type) {
    }

    public List<HotelResult> searchHotels(double lat, double lng, double radiusKm, double limit) {
        String query = ""
                + "\n    [out:json][timeout:12];"
                + "\n    ("
                + "\n      node[\"tourism\"~\"hotel|motel|hostel|guest_house\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n      way[\"tourism\"~\"hotel|motel|hostel|guest_house\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n    );"
                + "\n    out center body;"
                + "\n  ";

        try {
            JsonNode data = osm.overpassQuery(query);
            if (data == null) {
                return List.of();
            }

            List<HotelResult> hotels = new ArrayList<>();
            JsonNode elements = Json.arrOr(data, "elements");
            int taken = 0;
            for (JsonNode el : Json.elements(elements)) {
                if (taken >= limit) {
                    break;
                }
                taken++;
                Map<String, String> tags = tagStrings(el);
                Double hotelLat = coord(el, "lat", "lat");
                Double hotelLng = coord(el, "lon", "lon");
                if (hotelLat == null || hotelLng == null) {
                    continue;
                }

                JsonNode nameNode = el.path("tags").path("name");
                if (!Js.truthy(nameNode)) {
                    continue;
                }
                String name = Js.jsString(nameNode);

                int stars = getStarRating(tags);
                double dist = haversineDistance(lat, lng, hotelLat, hotelLng);
                double idValue = Js.num(el.path("id"));

                hotels.add(new HotelResult(
                        Double.isFinite(idValue) ? (long) idValue : hotels.size() + 1,
                        name,
                        hotelLat,
                        hotelLng,
                        addressOr(tags, "Nearby"),
                        stars,
                        estimatePrice(stars, tags),
                        "USD",
                        getAmenities(tags),
                        Math.round(dist * 100) / 100.0,
                        tags.getOrDefault("tourism", "hotel")));
            }

            hotels.sort((a, b) -> Double.compare(a.pricePerNight(), b.pricePerNight()));
            return hotels;
        } catch (Exception e) {
            return List.of();
        }
    }

    private static Map<String, String> tagStrings(JsonNode el) {
        Map<String, String> tags = new LinkedHashMap<>();
        JsonNode tagsNode = el.path("tags");
        if (tagsNode.isObject()) {
            tagsNode.fields().forEachRemaining(e -> tags.put(e.getKey(),
                    e.getValue().isTextual() ? e.getValue().asText() : Js.jsString(e.getValue())));
        }
        return tags;
    }

    /** TS {@code (el.lat as number) || el.center?.lat} + the falsy guard. */
    private static Double coord(JsonNode el, String direct, String centerField) {
        JsonNode n = el.path(direct);
        if (n.isNumber() && n.asDouble() != 0) {
            return n.asDouble();
        }
        JsonNode c = el.path("center").path(centerField);
        return c.isNumber() && c.asDouble() != 0 ? c.asDouble() : null;
    }

    private static String addressOr(Map<String, String> tags, String fallback) {
        String street = tags.get("addr:street");
        String house = tags.get("addr:housenumber");
        String city = tags.get("addr:city");
        List<String> parts = new ArrayList<>();
        for (String p : new String[] { street, house, city }) {
            if (p != null && !p.isEmpty()) {
                parts.add(p);
            }
        }
        return parts.isEmpty() ? fallback : String.join(" ", parts);
    }

    private static int getStarRating(Map<String, String> tags) {
        String starsTag = tags.get("stars");
        if (starsTag != null && !starsTag.isEmpty()) {
            try {
                int s = (int) Double.parseDouble(starsTag.trim());
                if (s >= 1 && s <= 5) {
                    return s;
                }
            } catch (NumberFormatException ignored) {
                // fall through
            }
        }
        String tourism = tags.getOrDefault("tourism", "");
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

    private static double estimatePrice(int stars, Map<String, String> tags) {
        Map<Integer, Double> base = new LinkedHashMap<>();
        base.put(1, 45.0);
        base.put(2, 75.0);
        base.put(3, 120.0);
        base.put(4, 200.0);
        base.put(5, 350.0);
        Double price = base.get(stars);
        double out = price != null ? price : 100;
        String tourism = tags.getOrDefault("tourism", "");
        if ("hostel".equals(tourism)) {
            out = 35;
        }
        if ("motel".equals(tourism)) {
            out = 65;
        }
        if ("guest_house".equals(tourism)) {
            out = 85;
        }
        return out;
    }

    private static List<String> getAmenities(Map<String, String> tags) {
        List<String> amenities = new ArrayList<>();
        String internet = tags.getOrDefault("internet_access", "");
        if ("yes".equals(internet) || "wlan".equals(internet)) {
            amenities.add("Free WiFi");
        }
        String parking = tags.getOrDefault("parking", "");
        if ("yes".equals(parking) || "surface".equals(parking)) {
            amenities.add("Parking");
        }
        if ("yes".equals(tags.getOrDefault("swimming_pool", ""))) {
            amenities.add("Pool");
        }
        if ("yes".equals(tags.getOrDefault("gym", ""))) {
            amenities.add("Gym");
        }
        if ("yes".equals(tags.getOrDefault("spa", ""))) {
            amenities.add("Spa");
        }
        if ("yes".equals(tags.getOrDefault("wheelchair", ""))) {
            amenities.add("Accessible");
        }
        if ("restaurant".equals(tags.getOrDefault("amenity", "")) || "yes".equals(tags.getOrDefault("food", ""))) {
            amenities.add("Restaurant");
        }
        if (amenities.isEmpty()) {
            amenities.add("WiFi");
        }
        return amenities;
    }

    private static double haversineDistance(double lat1, double lon1, double lat2, double lon2) {
        double R = 6371;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    public String formatHotelsForAgent(List<HotelResult> hotels) {
        if (hotels.isEmpty()) {
            return "No hotel data available.";
        }
        List<String> lines = new ArrayList<>();
        for (HotelResult h : hotels) {
            lines.add("- " + h.name() + " (" + h.stars() + "★, ~$" + Js.numStr(h.pricePerNight())
                    + "/night): " + h.type() + ", " + h.address() + ", " + Js.numStr(h.distanceFromCenter())
                    + "km from center, Amenities: " + String.join(", ", h.amenities()));
        }
        return String.join("\n", lines);
    }
}
