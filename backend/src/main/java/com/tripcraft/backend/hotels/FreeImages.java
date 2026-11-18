package com.tripcraft.backend.hotels;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/freeImages.ts} — free, keyless image sources shared
 * by every image route. Order matters: Wikimedia Commons first, then
 * Openverse. Every failure path returns an empty list instead of throwing.
 */
public final class FreeImages {

    private FreeImages() {
    }

    /** One mapped image result ({@code source} is "wikimedia commons" or an Openverse slug). */
    public record FreeImage(String url, String thumbnail, String title, String source, String link) {
    }

    /** {@code /\.(jpe?g|png|webp)$/i} on Wikimedia file titles. */
    private static final Pattern IMAGE_EXT = Pattern.compile("\\.(jpe?g|png|webp)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTTP = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    private static final String PLACEHOLDER_SVG =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"400\">"
                    + "<rect width=\"640\" height=\"400\" fill=\"#27272a\"/>"
                    + "<g fill=\"none\" stroke=\"#71717a\" stroke-width=\"10\" stroke-linecap=\"round\" "
                    + "stroke-linejoin=\"round\">"
                    + "<circle cx=\"320\" cy=\"170\" r=\"52\"/>"
                    + "<path d=\"M268 300l56-70 44 52 32-36 52 54z\"/>"
                    + "</g></svg>";

    /** Shown when every source fails. Neutral dark tile, no external fetch. */
    public static final String PLACEHOLDER_IMAGE =
            "data:image/svg+xml," + JsCompat.encodeURIComponent(PLACEHOLDER_SVG);

    /** Shared fetch for the image sources: parsed JSON for a 2xx, else {@code null}. */
    public static JsonNode fetchJson(String url, Map<String, String> headers, int timeoutMs) {
        Http.Raw res = headers == null ? Http.get(url, timeoutMs) : Http.get(url, headers, timeoutMs);
        return res.ok() ? res.json() : null;
    }

    /** JS {@code isValidUrl}: a string starting with http(s)://, else {@code null}. */
    public static String validUrl(JsonNode node) {
        if (node == null || !node.isTextual()) {
            return null;
        }
        String s = node.asText();
        return HTTP.matcher(s).find() ? s : null;
    }

    /** Free image source: Wikimedia Commons search (keyless, no quota). */
    public static List<FreeImage> commonsImages(String query) {
        try {
            String url = "https://commons.wikimedia.org/w/api.php?action=query&generator=search"
                    + "&gsrsearch=" + JsCompat.encodeURIComponent(query) + "&gsrnamespace=6&gsrlimit=12"
                    + "&prop=imageinfo&iiprop=url%7Csize&iiurlwidth=640&format=json&origin=*";
            JsonNode data = fetchJson(url, null, 7000);
            if (data == null) {
                return List.of();
            }
            List<FreeImage> out = new ArrayList<>();
            for (JsonNode p : jsObjectValues(data.path("query").path("pages"))) {
                String title = p.path("title").isTextual() ? p.path("title").asText() : "";
                if (!IMAGE_EXT.matcher(title).find()) {
                    continue;
                }
                JsonNode infoArray = p.path("imageinfo");
                JsonNode info = infoArray.isArray() && !infoArray.isEmpty() ? infoArray.get(0) : null;
                if (info == null) {
                    continue;
                }
                double w = info.path("width").isNumber() ? info.path("width").asDouble() : 0;
                if (w != 0 && w < 400) {
                    continue;
                }
                String thumb = validUrl(info.path("thumburl"));
                String direct = validUrl(info.path("url"));
                String u = thumb != null ? thumb : direct;
                if (u == null) {
                    continue;
                }
                String cleaned = title.replaceFirst("^File:", "").replaceFirst("\\.\\w+$", "");
                out.add(new FreeImage(
                        u,
                        u,
                        JsCompat.slice(cleaned, 160),
                        "wikimedia commons",
                        firstOrNull(validUrl(info.path("descriptionurl")))));
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** Free image source: Openverse (Flickr CC etc., keyless). */
    public static List<FreeImage> openverseImages(String query) {
        try {
            String url = "https://api.openverse.org/v1/images/?q=" + JsCompat.encodeURIComponent(query)
                    + "&page_size=10&mature=false";
            JsonNode data = fetchJson(url, Map.of("Accept", "application/json"), 7000);
            if (data == null) {
                return List.of();
            }
            List<FreeImage> out = new ArrayList<>();
            for (JsonNode r : Json.elements(data.get("results"))) {
                if (com.tripcraft.backend.places.Js.truthy(r.get("mature")) || validUrl(r.get("url")) == null) {
                    continue;
                }
                double w = r.path("width").isNumber() ? r.path("width").asDouble() : 0;
                if (w != 0 && w < 400) {
                    continue;
                }
                // Openverse's own thumbnail is a small server-side crop — use it instead
                // of the original, which can be a multi-megabyte photo.
                String thumbCandidate = validUrl(r.path("thumbnail"));
                String thumb = thumbCandidate != null ? thumbCandidate : r.get("url").asText();
                String titleNode = r.path("title").isTextual() && !r.path("title").asText().isEmpty()
                        ? r.path("title").asText()
                        : query;
                out.add(new FreeImage(
                        r.get("url").asText(),
                        thumb,
                        JsCompat.slice(titleNode, 160),
                        r.path("source").isTextual() ? r.path("source").asText() : "openverse",
                        firstOrNull(validUrl(r.path("foreign_landing_url")))));
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    // ------------------------------------------------------------ helpers

    private static String firstOrNull(String s) {
        return s == null ? "" : s;
    }

    /**
     * {@code Object.values(obj)} in JavaScript order: integer-like keys first in
     * ascending numeric order, then the remaining keys in document order.
     * Wikimedia keys its search pages by page id, so the numeric ordering is
     * what decides which images come back first.
     */
    public static List<JsonNode> jsObjectValues(JsonNode obj) {
        if (obj == null || !obj.isObject()) {
            return List.of();
        }
        List<Map.Entry<String, JsonNode>> numeric = new ArrayList<>();
        List<JsonNode> others = new ArrayList<>();
        var fields = obj.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            if (isUint32Key(entry.getKey())) {
                numeric.add(entry);
            } else {
                others.add(entry.getValue());
            }
        }
        numeric.sort(Comparator.comparingLong(e -> Long.parseLong(e.getKey())));
        List<JsonNode> out = new ArrayList<>(numeric.size() + others.size());
        for (Map.Entry<String, JsonNode> e : numeric) {
            out.add(e.getValue());
        }
        out.addAll(others);
        return out;
    }

    private static boolean isUint32Key(String key) {
        if (!key.matches("0|[1-9]\\d*")) {
            return false;
        }
        try {
            return Long.parseLong(key) < 4_294_967_295L;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
