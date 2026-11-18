package com.tripcraft.backend.hotels;

import java.util.Locale;

/**
 * JS {@code String} semantics the hotel/image ports need on top of
 * {@link com.tripcraft.backend.places.Js} (which covers numbers and JSON
 * coercion).
 */
public final class JsCompat {

    private JsCompat() {
    }

    /** JS {@code String.prototype.trim} — also strips NBSP / BOM, which {@link String#trim()} keeps. */
    public static String jsTrim(String s) {
        if (s == null) {
            return "";
        }
        int start = 0;
        int end = s.length();
        while (start < end && isJsSpace(s.charAt(start))) {
            start++;
        }
        while (end > start && isJsSpace(s.charAt(end - 1))) {
            end--;
        }
        return s.substring(start, end);
    }

    private static boolean isJsSpace(char c) {
        return c == '\uFEFF' || Character.isWhitespace(c) || Character.isSpaceChar(c);
    }

    /** JS {@code String.prototype.toLowerCase} (locale-independent, the Unicode default). */
    public static String jsLowerCase(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }

    /**
     * JS {@code encodeURIComponent}: escapes every byte except
     * {@code A–Z a–z 0–9 - _ . ! ~ * ' ( )}. {@link java.net.URLEncoder} is NOT
     * equivalent (space becomes {@code +}, which corrupts data URIs), so the
     * byte loop is deliberate.
     */
    public static String encodeURIComponent(String value) {
        byte[] bytes = (value == null ? "" : value).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder(bytes.length);
        for (byte b : bytes) {
            char c = (char) (b & 0xFF);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '!' || c == '~'
                    || c == '*' || c == '\'' || c == '(' || c == ')') {
                sb.append(c);
            } else {
                sb.append('%').append(String.format("%02X", b));
            }
        }
        return sb.toString();
    }

    /** JS {@code s.slice(0, max)} — UTF-16 code units, like {@code String.substring}. */
    public static String slice(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() > max ? s.substring(0, max) : s;
    }
}
