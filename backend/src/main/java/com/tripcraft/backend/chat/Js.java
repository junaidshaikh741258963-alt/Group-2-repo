package com.tripcraft.backend.chat;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Small JavaScript-semantics helpers.
 *
 * <p>The chat library is a line-by-line port of TypeScript, so the places where
 * JS string/number behaviour differs from Java's have to be reproduced rather
 * than "fixed":
 *
 * <ul>
 *   <li>{@link #trim}/{@link #trimEnd}/{@link #collapse} use JS's {@code \s}
 *       character class (Unicode whitespace, including NBSP / line
 *       separators) instead of {@link String#trim()} (chars &lt;= U+0020).</li>
 *   <li>{@link #parseFloat} mirrors {@code Number.parseFloat}: leading
 *       whitespace is skipped, parsing stops at the first illegal character
 *       ({@code "35.6abc"} → 35.6, {@code "0x10"} → 0), and anything
 *       unparseable is {@code NaN} — never an exception.</li>
 *   <li>{@link #numberToString} mirrors {@code String(number)}/{@code String(v)}
 *       used by {@code AiSchema.str()}: integral doubles print without the
 *       {@code .0} ({@code 2} → "2", not "2.0") and exponents use the JS
 *       {@code e+21} form.</li>
 * </ul>
 *
 * <p>Package-private on purpose: only the {@code chat} port uses these.
 */
final class Js {

    /** JS {@code trim()}: strip leading/trailing {@code \s}. */
    private static final Pattern TRIM = Pattern.compile("^\\s+|\\s+$", Pattern.UNICODE_CHARACTER_CLASS);
    /** JS {@code trimEnd()}. */
    private static final Pattern TRIM_END = Pattern.compile("\\s+$", Pattern.UNICODE_CHARACTER_CLASS);
    /** JS {@code replace(/\s+/g, " ")}. */
    private static final Pattern WS_RUN = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);

    private Js() {
    }

    static String trim(String s) {
        return TRIM.matcher(s).replaceAll("");
    }

    static String trimEnd(String s) {
        return TRIM_END.matcher(s).replaceAll("");
    }

    /** Collapse every whitespace run to a single space (JS {@code tidy()}'s first half). */
    static String collapse(String s) {
        return WS_RUN.matcher(s).replaceAll(" ");
    }

    /** Locale-independent JS {@code toLowerCase()}. */
    static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }

    /** JS {@code s.slice(from, to)} (UTF-16 code units, like Java's substring). */
    static String slice(String s, int from, int to) {
        int end = Math.min(to, s.length());
        if (from >= end) {
            return "";
        }
        return s.substring(Math.max(0, from), end);
    }

    /** TS truthiness for a string: any non-empty string is truthy. */
    static boolean truthy(String s) {
        return s != null && !s.isEmpty();
    }

    /**
     * {@code Number.parseFloat}: skips leading whitespace, accepts an optional
     * sign, digits, one dot and an exponent, then stops at the first character
     * that does not fit. Returns {@link Double#NaN} when no digits were found —
     * same values as V8 ({@code "35.6abc"} → 35.6, {@code "0x10"} → 0,
     * {@code "abc"} → NaN).
     */
    static double parseFloat(String s) {
        int i = 0;
        int n = s.length();
        while (i < n && Character.isWhitespace(s.charAt(i))) {
            i++;
        }
        int start = i;
        if (i < n && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
            i++;
        }
        boolean digits = false;
        while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
            i++;
            digits = true;
        }
        if (i < n && s.charAt(i) == '.') {
            i++;
            while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                i++;
                digits = true;
            }
        }
        if (digits && i < n && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
            int save = i;
            i++;
            if (i < n && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
                i++;
            }
            boolean expDigits = false;
            while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                i++;
                expDigits = true;
            }
            if (!expDigits) {
                i = save;
            }
        }
        if (!digits) {
            return Double.NaN;
        }
        try {
            return Double.parseDouble(s.substring(start, i));
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    /** {@code String(n)} for the number types JSON can carry. */
    static String numberToString(double n) {
        if (Double.isNaN(n)) {
            return "NaN";
        }
        if (Double.isInfinite(n)) {
            return n > 0 ? "Infinity" : "-Infinity";
        }
        if (n == Math.floor(n) && Math.abs(n) < 1e21) {
            return Long.toString((long) n);
        }
        String s = Double.toString(n);
        int e = s.indexOf('E');
        if (e != -1) {
            String mantissa = s.substring(0, e);
            if (mantissa.endsWith(".0")) {
                mantissa = mantissa.substring(0, mantissa.length() - 2);
            }
            String exp = s.substring(e + 1);
            if (!exp.startsWith("-")) {
                exp = "+" + exp;
            }
            return mantissa + "e" + exp;
        }
        return s;
    }
}
