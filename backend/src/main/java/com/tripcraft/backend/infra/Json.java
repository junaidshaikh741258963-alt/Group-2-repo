package com.tripcraft.backend.infra;

import java.util.Iterator;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * One {@link ObjectMapper} for the whole backend.
 *
 * <p>Two conventions the ports rely on:
 * <ul>
 *   <li>{@code ""} (empty string) rather than {@code null} for optional text
 *       fields, matching {@code AiSchema.str()} — this is what keeps every
 *       reply key present under the global {@code non_null} inclusion policy.</li>
 *   <li>{@link #optStr}/{@link #optNum} reproduce TypeScript's {@code a ?? b}
 *       for a value that may be absent, {@code null} or the wrong type.</li>
 * </ul>
 */
public final class Json {

    public static final ObjectMapper M = new ObjectMapper();

    private Json() {
    }

    public static JsonNode parseOrNull(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        try {
            return M.readTree(text);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    public static String write(Object value) {
        try {
            return M.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            return "{}";
        }
    }

    public static ObjectNode obj() {
        return M.createObjectNode();
    }

    public static ArrayNode arr() {
        return M.createArrayNode();
    }

    public static ArrayNode arr(JsonNode maybeArray) {
        return maybeArray != null && maybeArray.isArray() ? (ArrayNode) maybeArray : arr();
    }

    // ---------------------------------------------------------------- reads

    /** String field, defaulting on missing/null/wrong-type — TS {@code ??}. */
    public static String optStr(JsonNode node, String field, String fallback) {
        if (node == null) {
            return fallback;
        }
        JsonNode v = node.get(field);
        return v != null && v.isTextual() ? v.asText() : fallback;
    }

    /** Numeric field as a double, defaulting like TS {@code ??} / {@code | 0}. */
    public static double optNum(JsonNode node, String field, double fallback) {
        if (node == null) {
            return fallback;
        }
        JsonNode v = node.get(field);
        return v != null && v.isNumber() ? v.asDouble() : fallback;
    }

    public static int optInt(JsonNode node, String field, int fallback) {
        if (node == null) {
            return fallback;
        }
        JsonNode v = node.get(field);
        return v != null && v.isNumber() ? v.asInt() : fallback;
    }

    public static boolean optBool(JsonNode node, String field, boolean fallback) {
        if (node == null) {
            return fallback;
        }
        JsonNode v = node.get(field);
        return v != null && v.isBoolean() ? v.asBoolean() : fallback;
    }

    /** TS {@code data.items} where the caller only cares that it is an array. */
    public static JsonNode arrOr(JsonNode node, String field) {
        if (node == null) {
            return arr();
        }
        JsonNode v = node.get(field);
        return v != null && v.isArray() ? v : arr();
    }

    // ---------------------------------------------------------------- writes

    /** Skips blank values so optional keys stay absent, like JSON.stringify. */
    public static void putIfPresent(ObjectNode node, String field, String value) {
        if (value != null && !value.isEmpty()) {
            node.put(field, value);
        }
    }

    public static void putIfPresent(ObjectNode node, String field, Double value) {
        if (value != null && !value.isNaN()) {
            node.put(field, value);
        }
    }

    public static ObjectNode deepCopy(JsonNode node) {
        if (node == null) {
            return obj();
        }
        return node.deepCopy();
    }

    /** Iterates a node as an array, yielding nothing when it is not one. */
    public static Iterable<JsonNode> elements(JsonNode node) {
        if (node == null || !node.isArray()) {
            return java.util.List.of();
        }
        Iterator<JsonNode> it = node.elements();
        return () -> it;
    }
}
