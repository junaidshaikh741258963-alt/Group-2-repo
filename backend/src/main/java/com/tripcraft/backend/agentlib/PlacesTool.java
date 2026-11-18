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
 * Port of {@code src/lib/agent/places.ts} — Overpass attraction search for the
 * agent prompt.
 */
@Service
public class PlacesTool {

    private final OsmService osm;

    public PlacesTool(OsmService osm) {
        this.osm = osm;
    }

    public record Place(
            String name,
            String category,
            double lat,
            double lng,
            String address,
            String openingHours,
            String website,
            String phone) {
    }

    public List<Place> searchAttractions(double lat, double lng, double radiusKm, double limit) {
        String query = ""
                + "\n    [out:json][timeout:12];"
                + "\n    ("
                + "\n      node[\"tourism\"~\"attraction|museum|gallery|monument|artwork|viewpoint|zoo|aquarium\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n      node[\"leisure\"~\"park|garden|stadium|sports_centre\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n      node[\"amenity\"~\"place_of_worship|theatre|cinema|nightclub|cafe|restaurant|bar|pub\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n      way[\"tourism\"~\"attraction|museum|gallery|monument|artwork|viewpoint\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n      way[\"leisure\"~\"park|garden|stadium\"](around:"
                + Js.numStr(radiusKm * 1000) + "," + Js.numStr(lat) + "," + Js.numStr(lng) + ");"
                + "\n    );"
                + "\n    out center body;"
                + "\n  ";

        try {
            JsonNode data = osm.overpassQuery(query);
            if (data == null) {
                return List.of();
            }

            List<Place> places = new ArrayList<>();
            JsonNode elements = Json.arrOr(data, "elements");
            int taken = 0;
            for (JsonNode el : Json.elements(elements)) {
                if (taken >= limit) {
                    break;
                }
                taken++;
                Map<String, String> tags = tagStrings(el);
                Double placeLat = coord(el, "lat", "lat");
                Double placeLng = coord(el, "lon", "lon");
                if (placeLat == null || placeLng == null) {
                    continue;
                }

                JsonNode nameNode = el.path("tags").path("name");
                if (!Js.truthy(nameNode)) {
                    continue;
                }
                String name = Js.jsString(nameNode);

                places.add(new Place(
                        name,
                        getCategory(tags),
                        placeLat,
                        placeLng,
                        addressOr(tags),
                        tags.get("opening_hours"),
                        tags.get("website"),
                        nonBlank(tags.get("phone")) != null ? tags.get("phone") : tags.get("contact:phone")));
            }

            return places;
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

    private static String nonBlank(String s) {
        return s == null || s.isEmpty() ? null : s;
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

    private static String addressOr(Map<String, String> tags) {
        List<String> parts = new ArrayList<>();
        for (String p : new String[] { tags.get("addr:street"), tags.get("addr:housenumber"), tags.get("addr:city") }) {
            if (p != null && !p.isEmpty()) {
                parts.add(p);
            }
        }
        return String.join(" ", parts);
    }

    private static String getCategory(Map<String, String> tags) {
        String tourism = tags.getOrDefault("tourism", "");
        String leisure = tags.getOrDefault("leisure", "");
        String amenity = tags.getOrDefault("amenity", "");
        if ("museum".equals(tourism)) {
            return "museum";
        }
        if ("attraction".equals(tourism)) {
            return "attraction";
        }
        if ("viewpoint".equals(tourism)) {
            return "viewpoint";
        }
        if ("park".equals(leisure) || "garden".equals(leisure)) {
            return "park";
        }
        if ("restaurant".equals(amenity)) {
            return "restaurant";
        }
        if ("cafe".equals(amenity)) {
            return "cafe";
        }
        if ("bar".equals(amenity) || "pub".equals(amenity)) {
            return "nightlife";
        }
        if ("theatre".equals(amenity) || "cinema".equals(amenity)) {
            return "entertainment";
        }
        if ("place_of_worship".equals(amenity)) {
            return "religious";
        }
        if ("artwork".equals(tourism)) {
            return "monument";
        }
        return "attraction";
    }

    public String formatPlacesForAgent(List<Place> places) {
        if (places.isEmpty()) {
            return "No places data available.";
        }
        List<String> lines = new ArrayList<>();
        for (Place p : places) {
            String address = p.address() != null && !p.address().isEmpty() ? p.address() : "Near destination";
            String hours = p.openingHours() != null ? ", Hours: " + p.openingHours() : "";
            lines.add("- " + p.name() + " (" + p.category() + "): " + address + hours);
        }
        return String.join("\n", lines);
    }
}
