package com.tripcraft.backend.places;

import java.math.BigDecimal;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * JavaScript-semantics conversions shared by the places/agent endpoints.
 *
 * <p>The TypeScript originals lean on JS coercion everywhere
 * ({@code String(x)}, {@code Number(x)}, {@code x.toFixed(5)},
 * {@code x.toLocaleString()}), and the wire format must stay byte-comparable,
 * so each of those has an explicit port here rather than an ad-hoc Java
 * equivalent (where {@code 80.0} would serialise as {@code 80.0} instead of
 * {@code 80}).
 */
public final class Js {

    /** Leading numeric prefix, the way {@code parseFloat} scans a string. */
    private static final Pattern JS_FLOAT =
            Pattern.compile("^\\s*[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?");

    private Js() {
    }

    // ------------------------------------------------------------ coercion

    /** JS {@code parseFloat} — leading numeric prefix, else {@code NaN}. */
    public static double parseFloat(String raw) {
        if (raw == null) {
            return Double.NaN;
        }
        Matcher m = JS_FLOAT.matcher(raw);
        if (!m.find()) {
            return Double.NaN;
        }
        try {
            return Double.parseDouble(m.group());
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    /** JS {@code Number(value)} for a JSON node: missing → NaN, null → 0. */
    public static double num(JsonNode value) {
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
            String s = value.asText().trim();
            if (s.isEmpty()) {
                return 0;
            }
            try {
                return Double.parseDouble(s);
            } catch (NumberFormatException e) {
                return Double.NaN;
            }
        }
        return Double.NaN;
    }

    /** JS {@code String(value)} for a JSON node ({@code undefined}/{@code null} spelled out). */
    public static String jsString(JsonNode value) {
        if (value == null || value.isMissingNode()) {
            return "undefined";
        }
        if (value.isNull()) {
            return "null";
        }
        if (value.isTextual()) {
            return value.asText();
        }
        if (value.isNumber()) {
            return numStr(value.asDouble());
        }
        if (value.isBoolean()) {
            return value.asBoolean() ? "true" : "false";
        }
        if (value.isArray()) {
            List<String> parts = new ArrayList<>();
            for (JsonNode item : value) {
                String s = jsString(item);
                parts.add("null".equals(s) ? "null" : s);
            }
            return String.join(",", parts);
        }
        if (value.isObject()) {
            return "[object Object]";
        }
        return "undefined";
    }

    /** JS {@code String(number)} — integral values keep no trailing {@code .0}. */
    public static String numStr(double v) {
        if (Double.isNaN(v)) {
            return "NaN";
        }
        if (Double.isInfinite(v)) {
            return v > 0 ? "Infinity" : "-Infinity";
        }
        if (v == 0) {
            return "0"; // covers -0
        }
        if (v == Math.rint(v)) {
            if (Math.abs(v) < 1e18) {
                return Long.toString((long) v);
            }
            if (Math.abs(v) < 1e21) {
                return BigDecimal.valueOf(v).toPlainString();
            }
        }
        return Double.toString(v);
    }

    /** JS {@code Math.round} — half towards +∞, {@code NaN} in, {@code NaN} out. */
    public static double jsRound(double v) {
        return Double.isNaN(v) ? Double.NaN : Math.floor(v + 0.5);
    }

    /** {@code Number.prototype.toLocaleString()} with the default locale (en-US). */
    public static String toLocaleString(double v) {
        NumberFormat nf = NumberFormat.getNumberInstance(Locale.US);
        nf.setGroupingUsed(true);
        nf.setMinimumFractionDigits(0);
        nf.setMaximumFractionDigits(3);
        return nf.format(v);
    }

    /** JS truthiness for a JSON node. */
    public static boolean truthy(JsonNode value) {
        if (value == null || value.isMissingNode() || value.isNull()) {
            return false;
        }
        if (value.isBoolean()) {
            return value.asBoolean();
        }
        if (value.isNumber()) {
            double d = value.asDouble();
            return d != 0 && !Double.isNaN(d);
        }
        if (value.isTextual()) {
            return !value.asText().isEmpty();
        }
        return true; // arrays and objects are truthy in JS, even when empty
    }

    /** URL component encoding, matching {@code encodeURIComponent} closely enough for OSM. */
    public static String encode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------ helpers

    /** TS {@code num()} — only finite numbers survive, else {@code null} (= {@code undefined}). */
    public static Double finite(JsonNode value) {
        if (value != null && value.isNumber()) {
            double d = value.asDouble();
            if (Double.isFinite(d)) {
                return d;
            }
        }
        return null;
    }

    /** TS {@code str()} — trimmed, bounded, {@code undefined} when blank or not a string. */
    public static String str(JsonNode value, int max) {
        if (value == null || !value.isTextual()) {
            return null;
        }
        String s = value.asText().trim();
        if (s.isEmpty()) {
            return null;
        }
        return s.length() > max ? s.substring(0, max) : s;
    }

    public static double clamp(double v, double lo, double hi) {
        return Math.min(Math.max(v, lo), hi);
    }

    /**
     * Writes a number the way {@code JSON.stringify} would: integers without a
     * decimal point, {@code NaN}/{@code ±Infinity} as {@code null}.
     */
    public static void putNum(ObjectNode node, String field, double v) {
        if (!Double.isFinite(v)) {
            node.putNull(field);
        } else if (v == Math.rint(v) && Math.abs(v) < 1e15) {
            node.put(field, (long) v);
        } else {
            node.put(field, v);
        }
    }

    /** Copies a node verbatim when it is present ({@code null} stays, missing is omitted). */
    public static void putRaw(ObjectNode node, String field, JsonNode value) {
        if (value != null && !value.isMissingNode()) {
            node.set(field, value);
        }
    }
}
