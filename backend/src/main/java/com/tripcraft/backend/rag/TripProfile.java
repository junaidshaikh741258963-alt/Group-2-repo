package com.tripcraft.backend.rag;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * The trip profile — a fixed set of nullable string fields, mirroring
 * {@code TripProfile} in {@code src/lib/tripProfile.ts} (field names and the
 * {@code EMPTY_PROFILE} key set are identical).
 *
 * <p>The RAG side only reads {@link #destination()} plus a structural
 * fingerprint of the whole object (cache key), but every field is kept so a
 * JSON round trip behaves like {@code {...EMPTY_PROFILE, ...sanitised}}.
 */
public final class TripProfile {

    /** Key order of {@code EMPTY_PROFILE} — also the JSON key order. */
    public static final List<String> FIELDS = List.of(
            "destination", "dates", "people", "budget", "interests", "duration",
            "accommodation", "hotel", "restaurants", "attractions", "itinerary");

    private final Map<String, String> values;

    private TripProfile(Map<String, String> values) {
        this.values = values;
    }

    /** Every field {@code null} — the {@code EMPTY_PROFILE} object. */
    public static TripProfile empty() {
        Map<String, String> map = new LinkedHashMap<>();
        for (String field : FIELDS) {
            map.put(field, null);
        }
        return new TripProfile(map);
    }

    public static TripProfile of(Map<String, String> values) {
        Map<String, String> map = new LinkedHashMap<>();
        for (String field : FIELDS) {
            map.put(field, values.get(field));
        }
        return new TripProfile(map);
    }

    /** Nullable field value — TS {@code profile[field]}. */
    public String get(String field) {
        return values.get(field);
    }

    public void set(String field, String value) {
        values.put(field, value);
    }

    public String destination() {
        return values.get("destination");
    }

    /** Serialises exactly like {@code JSON.stringify(profile)}: all keys, nulls kept. */
    public ObjectNode toJson() {
        ObjectNode node = Json.obj();
        for (String field : FIELDS) {
            String value = values.get(field);
            if (value == null) {
                node.putNull(field);
            } else {
                node.put(field, value);
            }
        }
        return node;
    }
}
