package com.tripcraft.backend.hotels;

import java.text.Normalizer;import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/lib/placeQuery.ts} — server-only place disambiguation for
 * image search. Turns "Le Marais" (+ its coordinates) into
 * "Le Marais Paris France" so free sources stop returning the countryside
 * wetland, and validates that result titles actually mention the place or its
 * city.
 */
public final class PlaceQuery {

    private PlaceQuery() {
    }

    /** Free reverse-geocode outcome: city and country, {@code null} when unknown. */
    public record Geo(String city, String country) {
    }

    /** A fully-resolved search context: "{place} {city} {country}" + match tokens. */
    public record PlaceContext(String city, String country, String query,
            Set<String> placeTokens, Set<String> cityTokens) {
    }

    private static final int GEO_CACHE_MAX = 500;
    private static final Map<String, Geo> GEO_CACHE = Collections.synchronizedMap(new LinkedHashMap<>());

    private static final Set<String> STOPWORDS = Set.of(
            "the", "a", "an", "of", "in", "on", "at", "and", "or", "de", "la", "le",
            "les", "du", "des", "au", "aux", "en", "un", "une", "el", "los", "las",
            "il", "lo", "die", "der", "das", "y", "e");

    private static final Pattern COMBINING = Pattern.compile("[\u0300-\u036f]");
    private static final Pattern NON_ALNUM = Pattern.compile("[^a-z0-9]+");

    public static String norm(String s) {
        String x = Normalizer.normalize(JsCompat.jsLowerCase(s), Normalizer.Form.NFKD);
        x = COMBINING.matcher(x).replaceAll("");
        x = NON_ALNUM.matcher(x).replaceAll(" ");
        return x.trim();
    }

    /** Content tokens: normed words longer than two characters that are not stopwords. */
    public static Set<String> contentTokens(String s) {
        Set<String> out = new HashSet<>();
        for (String t : norm(s == null ? "" : s).split(" ")) {
            if (t.length() > 2 && !STOPWORDS.contains(t)) {
                out.add(t);
            }
        }
        return out;
    }

    /** Free reverse-geocode (Nominatim) → city + country. Cached indefinitely on success. */
    public static Geo reverseGeocode(double lat, double lng) {
        String key = fmt(lat, 3) + "," + fmt(lng, 3);
        Geo hit = GEO_CACHE.get(key);
        if (hit != null) {
            return hit;
        }
        Geo empty = new Geo(null, null);
        try {
            String url = "https://nominatim.openstreetmap.org/reverse?format=json"
                    + "&lat=" + Js.numStr(lat) + "&lon=" + Js.numStr(lng)
                    + "&zoom=10&addressdetails=1";
            Http.Raw res = Http.get(url, Map.of("Accept", "application/json"), 6000);
            if (!res.ok()) {
                return empty;
            }
            JsonNode data = res.json();
            JsonNode addr = data == null ? null : data.get("address");
            String city = firstText(addr, "city", "town", "village", "municipality", "county");
            String country = firstText(addr, "country");
            Geo result = new Geo(city, country);
            synchronized (GEO_CACHE) {
                if (GEO_CACHE.size() >= GEO_CACHE_MAX) {
                    var oldest = GEO_CACHE.keySet().iterator();
                    if (oldest.hasNext()) {
                        oldest.next();
                        oldest.remove();
                    }
                }
                GEO_CACHE.put(key, result);
            }
            return result;
        } catch (Exception e) {
            return empty;
        }
    }

    /**
     * Resolve the full search context for a place. City/country provided by the
     * caller win; missing ones are reverse-geocoded when coordinates are known.
     */
    public static PlaceContext resolvePlaceContext(String name, Double lat, Double lng, String city, String country) {
        String c = blankToNull(city);
        String co = blankToNull(country);
        if ((c == null || co == null)
                && lat != null && lng != null && Double.isFinite(lat) && Double.isFinite(lng)) {
            Geo geo = reverseGeocode(lat, lng);
            c = c != null ? c : geo.city();
            co = co != null ? co : geo.country();
        }
        String query = joinParts(name == null ? "" : name.trim(), c, co);
        Set<String> placeTokens = contentTokens(name == null ? "" : name);
        Set<String> cityTokens = new HashSet<>(contentTokens(c == null ? "" : c));
        cityTokens.addAll(contentTokens(co == null ? "" : co));
        return new PlaceContext(c, co, query, placeTokens, cityTokens);
    }

    /** True when a result title mentions the place or its city. */
    public static boolean titleMentions(String title, PlaceContext ctx) {
        return titleMentions(title, ctx.placeTokens(), ctx.cityTokens());
    }

    /** True when a result title mentions any of the given token sets. */
    public static boolean titleMentions(String title, Set<String> placeTokens, Set<String> cityTokens) {
        if (title == null || title.isEmpty()) {
            return false;
        }
        for (String t : norm(title).split(" ")) {
            if (t.length() > 2 && (placeTokens.contains(t) || cityTokens.contains(t))) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ helpers

    /** {@code lat.toFixed(n)} for cache keys and coordinates. */
    public static String fmt(double v, int digits) {
        return String.format(Locale.US, "%." + digits + "f", v);
    }

    private static String blankToNull(String s) {
        String t = JsCompat.jsTrim(s);
        return t.isEmpty() ? null : t;
    }

    private static String joinParts(String first, String... rest) {
        StringBuilder sb = new StringBuilder(first);
        for (String part : rest) {
            if (part != null && !part.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append(' ');
                }
                sb.append(part);
            }
        }
        return sb.toString();
    }

    /** First textual, non-empty field among {@code keys} — the TS {@code a || b || c} chain. */
    private static String firstText(JsonNode addr, String... keys) {
        if (addr == null || !addr.isObject()) {
            return null;
        }
        for (String key : keys) {
            JsonNode v = addr.get(key);
            if (v != null && v.isTextual() && !v.asText().isEmpty()) {
                return v.asText();
            }
        }
        return null;
    }
}
