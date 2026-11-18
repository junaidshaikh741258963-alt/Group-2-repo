package com.tripcraft.backend.trains;

import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/trains.ts} — the wire shape of a station suggestion,
 * a journey leg and a whole journey, plus the TypeScript field readers every
 * train provider shares ({@code a.b || ""}, {@code Number(x)},
 * {@code encodeURIComponent}, …).
 *
 * <p>Optional TS fields ({@code lat?}, {@code lng?}, {@code price?},
 * {@code currency?}) become nullable Java fields whose key is simply not put
 * when {@code null}, exactly as {@code JSON.stringify} drops {@code undefined}.
 * {@code TrainLeg.durationMin} is the opposite: the TS always emits it, so it
 * is written as an explicit {@code null} when there is no value.
 */
public final class Trains {

    private static final Pattern COMBINING = Pattern.compile("[\u0300-\u036f]");
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    private Trains() {
    }

    // --------------------------------------------------------- TS helpers

    /** Lowercase, strip diacritics, trim — the shared {@code normalize()} of the TS. */
    public static String normalize(String value) {
        String s = (value == null ? "" : value).toLowerCase(Locale.ROOT);
        s = Normalizer.normalize(s, Normalizer.Form.NFD);
        s = COMBINING.matcher(s).replaceAll("");
        return s.trim();
    }

    /**
     * Scalar field as text: {@code null} when absent or JSON {@code null} (the
     * JS {@code undefined}/{@code null} the {@code ??} and {@code ||} chains
     * key off). Numbers and booleans stringify like {@code String(value)}.
     */
    public static String text(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) {
            return null;
        }
        if (v.isTextual() || v.isNumber() || v.isBoolean()) {
            return v.asText();
        }
        return null;
    }

    /** TS truthiness for strings: {@code null}/empty → {@code null} ({@code || undefined}). */
    public static String truthy(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    public static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** TS {@code typeof x === "number" ? x : undefined}. */
    public static Double numberOrNull(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode v = node.get(field);
        return v != null && v.isNumber() ? v.asDouble() : null;
    }

    /** JS truthiness of a whole JSON value ({@code undefined}/{@code null}/0/""/false are falsy). */
    public static boolean jsTruthy(JsonNode value) {
        if (value == null || value.isNull() || value.isMissingNode()) {
            return false;
        }
        if (value.isBoolean()) {
            return value.asBoolean();
        }
        if (value.isTextual()) {
            return !value.asText().isEmpty();
        }
        if (value.isNumber()) {
            return value.asDouble() != 0;
        }
        return true;
    }

    /** JS {@code Number(node.field)} — {@code NaN} when there is no number to read. */
    public static double jsNumber(JsonNode node, String field) {
        return jsNumberValue(node == null ? null : node.get(field));
    }

    /**
     * JS {@code Number(value)}: a missing field is {@code undefined} →
     * {@code NaN}, JSON {@code null} and {@code ""} are {@code 0}, everything
     * else parses as a double or is {@code NaN}.
     */
    public static double jsNumberValue(JsonNode value) {
        if (value == null || value.isMissingNode()) {
            return Double.NaN;
        }
        if (value.isNull()) {
            return 0;
        }
        if (value.isNumber()) {
            return value.asDouble();
        }
        if (value.isBoolean()) {
            return value.asBoolean() ? 1 : 0;
        }
        if (value.isTextual()) {
            return jsNumberText(value.asText());
        }
        return Double.NaN;
    }

    /** JS {@code Number(string)} for a raw string (no node involved). */
    public static double jsNumberText(String raw) {
        if (raw == null) {
            return Double.NaN;
        }
        String s = raw.trim();
        if (s.isEmpty()) {
            return 0;
        }
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    /**
     * Whole numbers serialise without a {@code .0} suffix so the bytes match
     * {@code JSON.stringify} (JS has a single Number type).
     */
    public static void putNum(ObjectNode node, String field, double value) {
        if (value == Math.floor(value) && !Double.isInfinite(value) && Math.abs(value) <= 9.0e15) {
            node.put(field, (long) value);
        } else {
            node.put(field, value);
        }
    }

    /** JS {@code String(number)}: whole numbers without a {@code .0} suffix. */
    public static String numText(double value) {
        if (value == Math.floor(value) && !Double.isInfinite(value) && Math.abs(value) <= 9.0e15) {
            return Long.toString((long) value);
        }
        return String.valueOf(value);
    }

    /** {@code encodeURIComponent} — UTF-8 bytes, {@code A–Z a–z 0–9 - _ . ! ~ * ' ( )} kept. */
    public static String encodeComponent(String value) {
        StringBuilder sb = new StringBuilder();
        for (byte b : (value == null ? "" : value).getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '!' || c == '~'
                    || c == '*' || c == '\'' || c == '(' || c == ')') {
                sb.append((char) c);
            } else {
                sb.append('%').append(HEX[c >> 4]).append(HEX[c & 0x0f]);
            }
        }
        return sb.toString();
    }

    /** {@code URLSearchParams.set()} — spaces become {@code +}, everything else %XX. */
    public static String encodeForm(String value) {
        StringBuilder sb = new StringBuilder();
        for (byte b : (value == null ? "" : value).getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if (c == ' ') {
                sb.append('+');
            } else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '*' || c == '-' || c == '.' || c == '_') {
                sb.append((char) c);
            } else {
                sb.append('%').append(HEX[c >> 4]).append(HEX[c & 0x0f]);
            }
        }
        return sb.toString();
    }

    /** JS {@code String.prototype.slice(from, to)} — clamped, never throws. */
    public static String slice(String value, int from, int to) {
        if (value == null) {
            return "";
        }
        int len = value.length();
        int start = from < 0 ? Math.max(len + from, 0) : Math.min(from, len);
        int end = to < 0 ? Math.max(len + to, 0) : Math.min(to, len);
        return end <= start ? "" : value.substring(start, end);
    }

    // --------------------------------------------------------- wire shape

    /** Port of the {@code StationSuggestion} interface. */
    public record StationSuggestion(String id, String name, String type, Double lat, Double lng) {

        public ObjectNode toJson() {
            ObjectNode node = Json.obj();
            node.put("id", id);
            node.put("name", name);
            node.put("type", type);
            if (lat != null) {
                putNum(node, "lat", lat);
            }
            if (lng != null) {
                putNum(node, "lng", lng);
            }
            return node;
        }
    }

    /** Port of the {@code TrainLeg} interface — {@code durationMin} is always present. */
    public record TrainLeg(String kind, String line, String product, String operator,
                           String direction, String from, String to, String depart,
                           String arrive, Double durationMin) {

        public ObjectNode toJson() {
            ObjectNode node = Json.obj();
            node.put("kind", kind);
            node.put("line", line);
            node.put("product", product);
            node.put("operator", operator);
            node.put("direction", direction);
            node.put("from", from);
            node.put("to", to);
            node.put("depart", depart);
            node.put("arrive", arrive);
            if (durationMin == null) {
                node.putNull("durationMin");
            } else {
                putNum(node, "durationMin", durationMin);
            }
            return node;
        }
    }

    /** Port of the {@code TrainJourney} interface — {@code price}/{@code currency} optional. */
    public record TrainJourney(String departAt, String arriveAt, double durationMin,
                               double transfers, String from, String to, Double price,
                               String currency, List<TrainLeg> legs) {

        public ObjectNode toJson() {
            ObjectNode node = Json.obj();
            node.put("departAt", departAt);
            node.put("arriveAt", arriveAt);
            putNum(node, "durationMin", durationMin);
            putNum(node, "transfers", transfers);
            node.put("from", from);
            node.put("to", to);
            if (price != null) {
                putNum(node, "price", price);
            }
            if (currency != null) {
                node.put("currency", currency);
            }
            ArrayNode list = node.putArray("legs");
            for (TrainLeg leg : legs) {
                list.add(leg.toJson());
            }
            return node;
        }
    }
}
