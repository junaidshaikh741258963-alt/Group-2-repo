package com.tripcraft.backend.hotels;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.chat.AiSchema.AiReply;
import com.tripcraft.backend.chat.AiSchema.StructuredPlace;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/lib/recommendations.ts} — the card vocabulary of the
 * chat: the {@code Recommendation} shape, the {@code <recommendations>}
 * block splitter and the {@code itemsFromStructured}/{@code itemsForAssistant}
 * mapping that decides which cards the chat page draws.
 *
 * <p>The id scheme is reproduced verbatim: structured replies number their
 * cards {@code ${messageId}:s${index}}, free-form blocks
 * {@code ${messageId}:${index}}. The identity caches from the TS (which keep
 * streaming re-renders cheap) are kept too, including the "same instances in,
 * same instance out" stability guarantees.
 */
public final class Recommendations {

    private Recommendations() {
    }

    /** The card categories the renderer knows, plus the airport extra. */
    public enum RecType {
        DESTINATION("destination", "\uD83D\uDCCD", "#3b82f6", "Destination"),
        HOTEL("hotel", "\uD83C\uDFE8", "#a855f7", "Hotel"),
        RESTAURANT("restaurant", "\uD83C\uDF7D\uFE0F", "#f97316", "Restaurant"),
        ATTRACTION("attraction", "\uD83C\uDFAF", "#10b981", "Attraction"),
        AIRPORT("airport", "✈\uFE0F", "#38bdf8", "Airport");

        public final String wire;
        public final String emoji;
        public final String color;
        public final String label;

        RecType(String wire, String emoji, String color, String label) {
            this.wire = wire;
            this.emoji = emoji;
            this.color = color;
            this.label = label;
        }

        public static RecType fromWire(String value) {
            for (RecType t : values()) {
                if (t.wire.equals(value)) {
                    return t;
                }
            }
            return null;
        }
    }

    /** Category meta ({@code recMeta()} in the TS). */
    public record RecMeta(String emoji, String color, String label) {
    }

    /**
     * One recommendation card. Optional fields are {@code null} and
     * {@link #wire()} omits them, exactly like {@code JSON.stringify} dropping
     * {@code undefined}.
     */
    public record Recommendation(
            String id,
            String name,
            RecType type,
            Double lat,
            Double lng,
            String city,
            String description,
            Double rating,
            Integer reviews,
            String price,
            String source,
            String image,
            String propertyToken,
            String link) {

        public Recommendation withId(String newId) {
            return new Recommendation(newId, name, type, lat, lng, city, description,
                    rating, reviews, price, source, image, propertyToken, link);
        }

        /** JSON.stringify semantics: nulls skipped, integral numbers without a decimal point. */
        public ObjectNode wire() {
            ObjectNode n = Json.obj();
            if (id != null) {
                n.put("id", id);
            }
            if (name != null) {
                n.put("name", name);
            }
            if (type != null) {
                n.put("type", type.wire);
            }
            if (lat != null) {
                Js.putNum(n, "lat", lat);
            }
            if (lng != null) {
                Js.putNum(n, "lng", lng);
            }
            if (city != null) {
                n.put("city", city);
            }
            if (description != null) {
                n.put("description", description);
            }
            if (rating != null) {
                Js.putNum(n, "rating", rating);
            }
            if (reviews != null) {
                n.put("reviews", reviews);
            }
            if (price != null) {
                n.put("price", price);
            }
            if (source != null) {
                n.put("source", source);
            }
            if (image != null) {
                n.put("image", image);
            }
            if (propertyToken != null) {
                n.put("propertyToken", propertyToken);
            }
            if (link != null) {
                n.put("link", link);
            }
            return n;
        }
    }

    /** One assistant message as {@code collectRecommendations} sees it. */
    public record ChatMessage(String id, String role, String content, AiReply structured) {
    }

    /** {@code splitRecommendations()} output: visible text + stable-numbered items. */
    public record SplitResult(String text, List<Recommendation> items) {
    }

    /** {@code partitionMarkdown()} output: stable prefix + streaming tail. */
    public record MarkdownSplit(String stable, String tail) {
    }

    private static final String OPEN_TAG = "<recommendations>";
    private static final String CLOSE_TAG = "</recommendations>";

    private static final Pattern REC_BLOCK =
            Pattern.compile("<recommendations>([\\s\\S]*?)</recommendations>");
    private static final Pattern TRAILING_FENCE =
            Pattern.compile("```(?:json)?\\s*$", Pattern.CASE_INSENSITIVE);

    private static final Set<String> VALID_TYPES = Set.of("destination", "hotel", "restaurant", "attraction");

    private record ImgRule(Pattern match, String img) {
    }

    private static final List<ImgRule> PLACE_IMAGES = List.of(
            new ImgRule(Pattern.compile("paris|eiffel", Pattern.CASE_INSENSITIVE), ShowcasePhotos.PARIS),
            new ImgRule(Pattern.compile("santorini|greece", Pattern.CASE_INSENSITIVE), ShowcasePhotos.SANTORINI),
            new ImgRule(Pattern.compile("machu picchu|peru|cusco", Pattern.CASE_INSENSITIVE),
                    "https://images.unsplash.com/photo-1526392060635-9d6019884377?w=600&q=80&auto=format&fit=crop"),
            new ImgRule(Pattern.compile("kyoto|japan|tokyo", Pattern.CASE_INSENSITIVE), ShowcasePhotos.TOKYO),
            new ImgRule(Pattern.compile("amalfi|italy|rome|venice|florence", Pattern.CASE_INSENSITIVE),
                    "https://images.unsplash.com/photo-1534308983496-4fabb1a015ee?w=600&q=80&auto=format&fit=crop"),
            new ImgRule(Pattern.compile("maldives", Pattern.CASE_INSENSITIVE), ShowcasePhotos.MALDIVES),
            new ImgRule(Pattern.compile("swiss|alps|zurich|switzerland", Pattern.CASE_INSENSITIVE),
                    "https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=600&q=80&auto=format&fit=crop"),
            new ImgRule(Pattern.compile("bali|indonesia", Pattern.CASE_INSENSITIVE), ShowcasePhotos.BALI),
            new ImgRule(Pattern.compile("london|uk|england", Pattern.CASE_INSENSITIVE),
                    "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=600&q=80&auto=format&fit=crop"),
            new ImgRule(Pattern.compile("dubai", Pattern.CASE_INSENSITIVE),
                    "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?w=600&q=80&auto=format&fit=crop"),
            new ImgRule(Pattern.compile("new york|nyc|manhattan", Pattern.CASE_INSENSITIVE), ShowcasePhotos.NEW_YORK),
            new ImgRule(Pattern.compile("barcelona|spain", Pattern.CASE_INSENSITIVE),
                    "https://images.unsplash.com/photo-1583422409516-2895a77efded?w=600&q=80&auto=format&fit=crop"));

    private static final Pattern HTTP_I = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTTP_STRICT = Pattern.compile("^https?://");

    // ------------------------------------------------------------- meta

    public static RecMeta recMeta(RecType type) {
        return new RecMeta(type.emoji, type.color, type.label);
    }

    /**
     * Image for a single place. Prefers the image returned with that
     * recommendation. Returns {@code null} when there is no per-place image —
     * callers resolve further or show a placeholder. City stock photos apply
     * ONLY to destination cards; never to hotels/restaurants/attractions.
     */
    public static String recImage(RecType type, String name, String image) {
        if (image != null) {
            String trimmed = JsCompat.jsTrim(image);
            if (HTTP_I.matcher(trimmed).find()) {
                return trimmed;
            }
        }
        if (type != RecType.DESTINATION) {
            return null;
        }
        for (ImgRule rule : PLACE_IMAGES) {
            if (rule.match().matcher(name == null ? "" : name).find()) {
                return rule.img();
            }
        }
        return null;
    }

    /**
     * TS {@code coerceType(value: unknown)} — {@code String(value ?? "")} first, so a raw
     * JSON node of any kind is accepted (text/number/boolean use their text form; an object
     * or array yields {@code ""}, matching JS's non-matching {@code "[object Object]"}).
     */
    public static RecType coerceType(com.fasterxml.jackson.databind.JsonNode value) {
        if (value == null || value.isNull()) {
            return coerceType("");
        }
        if (value.isContainerNode()) {
            return coerceType("");
        }
        return coerceType(value.asText());
    }

    /** Maps a raw category string ("hotel", "museum", "resort"…) to a RecType. */
    public static RecType coerceType(String value) {
        String t = JsCompat.jsLowerCase(JsCompat.jsTrim(value == null ? "" : value));
        if (VALID_TYPES.contains(t)) {
            return RecType.fromWire(t);
        }
        if (t.equals("attraction") || t.equals("sight") || t.equals("landmark") || t.equals("museum")) {
            return RecType.ATTRACTION;
        }
        if (t.equals("hostel") || t.equals("guesthouse") || t.equals("guest_house")
                || t.equals("motel") || t.equals("b&b") || t.equals("bnb") || t.equals("inn")
                || t.equals("lodge") || t.equals("lodging") || t.equals("resort")
                || t.equals("apartment")) {
            return RecType.HOTEL;
        }
        return RecType.ATTRACTION;
    }

    // ------------------------------------------------------------ parsing

    /** {@code JSON.parse} of one {@code <recommendations>} block body (≤ 24 usable entries). */
    private static List<Recommendation> parseItems(String raw) {
        String trimmed = JsCompat.jsTrim(raw == null ? "" : raw);
        com.fasterxml.jackson.databind.JsonNode data = Json.parseOrNull(trimmed);
        if (data == null) {
            int s = trimmed.indexOf('[');
            int e = trimmed.lastIndexOf(']');
            if (s != -1 && e > s) {
                data = Json.parseOrNull(trimmed.substring(s, e + 1));
            }
            if (data == null) {
                return new ArrayList<>();
            }
        }

        List<com.fasterxml.jackson.databind.JsonNode> arr = new ArrayList<>();
        if (data.isArray()) {
            data.forEach(arr::add);
        } else if (data.isObject() && data.get("recommendations") != null
                && data.get("recommendations").isArray()) {
            data.get("recommendations").forEach(arr::add);
        }

        List<Recommendation> out = new ArrayList<>();
        for (com.fasterxml.jackson.databind.JsonNode entry : arr) {
            if (entry == null || !entry.isObject()) {
                continue;
            }
            String name = entry.get("name") != null && entry.get("name").isTextual()
                    ? entry.get("name").asText().trim()
                    : "";
            double lat = numLike(entry, "lat");
            double lng = numLike(entry, "lng");
            if (name.isEmpty() || !Double.isFinite(lat) || !Double.isFinite(lng)) {
                continue;
            }
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                continue;
            }
            double rating = numLike(entry, "rating");
            String description = entry.get("description") != null && entry.get("description").isTextual()
                    ? JsCompat.slice(entry.get("description").asText(), 160)
                    : null;
            Double ratingOut = Double.isFinite(rating) && rating >= 0 && rating <= 5
                    ? Math.round(rating * 10) / 10.0
                    : null;
            String price = entry.get("price") != null && entry.get("price").isTextual()
                    ? JsCompat.slice(entry.get("price").asText(), 40)
                    : null;
            String image = entry.get("image") != null && entry.get("image").isTextual()
                    && HTTP_STRICT.matcher(entry.get("image").asText()).find()
                            ? JsCompat.slice(entry.get("image").asText(), 500)
                            : null;
            out.add(new Recommendation(null, name, coerceType((com.fasterxml.jackson.databind.JsonNode) entry.get("type")), lat, lng, null,
                    description, ratingOut, null, price, null, image, null, null));
            if (out.size() >= 24) {
                break;
            }
        }
        return out;
    }

    /** TS {@code typeof r.lat === "number" ? r.lat : parseFloat(String(r.lat))}. */
    private static double numLike(com.fasterxml.jackson.databind.JsonNode parent, String field) {
        com.fasterxml.jackson.databind.JsonNode v = parent.get(field);
        if (v != null && v.isNumber()) {
            return v.asDouble();
        }
        String text = v == null ? "undefined" : Js.jsString(v);
        return Js.parseFloat(text);
    }

    /**
     * Parse ALL {@code <recommendations>} blocks in a message (the model may
     * emit one per category). Returns the visible text with every block
     * removed, plus items numbered stably across blocks. An unclosed block
     * (mid-stream) is hidden from the text and yields no items.
     */
    private static SplitResult computeSplitRecommendations(String content) {
        int firstOpen = content.indexOf(OPEN_TAG);
        if (firstOpen == -1) {
            return new SplitResult(content, new ArrayList<>());
        }

        // Hide a block that is still streaming in (open tag with no close yet).
        int cutAt = content.length();
        for (int i = firstOpen; i != -1; i = content.indexOf(OPEN_TAG, i + 1)) {
            if (content.indexOf(CLOSE_TAG, i) == -1) {
                cutAt = i;
                break;
            }
        }

        List<Recommendation> items = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        int cursor = 0;
        Matcher m = REC_BLOCK.matcher(content);
        while (m.find()) {
            if (m.start() >= cutAt) {
                break;
            }
            text.append(content, cursor, m.start());
            cursor = m.end();
            for (Recommendation r : parseItems(m.group(1))) {
                if (items.size() >= 36) {
                    break;
                }
                items.add(r.withId(String.valueOf(items.size())));
            }
            if (items.size() >= 36) {
                break;
            }
        }
        text.append(content, cursor, cutAt);

        String visible = TRAILING_FENCE.matcher(text.toString()).replaceFirst("");
        return new SplitResult(JsCompat.jsTrim(visible), items);
    }

    private static final int SPLIT_CACHE_LIMIT = 256;
    private static final Map<String, SplitResult> SPLIT_CACHE = new LinkedHashMap<>();

    public static SplitResult splitRecommendations(String content) {
        synchronized (SPLIT_CACHE) {
            SplitResult cached = SPLIT_CACHE.get(content);
            if (cached != null) {
                // Refresh recency so live content wins over stale streaming chunks.
                SPLIT_CACHE.remove(content);
                SPLIT_CACHE.put(content, cached);
                return cached;
            }
            SplitResult result = computeSplitRecommendations(content);
            if (SPLIT_CACHE.size() >= SPLIT_CACHE_LIMIT) {
                Iterator<String> oldest = SPLIT_CACHE.keySet().iterator();
                if (oldest.hasNext()) {
                    oldest.next();
                    oldest.remove();
                }
            }
            SPLIT_CACHE.put(content, result);
            return result;
        }
    }

    public static List<Recommendation> itemsForMessage(String messageId, String content) {
        List<Recommendation> out = new ArrayList<>();
        for (Recommendation item : splitRecommendations(content).items()) {
            out.add(item.withId(messageId + ":" + item.id()));
        }
        return out;
    }

    /**
     * Cards for a structured reply. Ids are {@code ${messageId}:s${index}} so
     * the chat card, the map pin and the itinerary timeline all reference the
     * same place.
     */
    public static List<Recommendation> itemsFromStructured(String messageId, AiReply reply) {
        List<Recommendation> out = new ArrayList<>();
        int index = 0;
        for (StructuredPlace p : reply.places()) {
            // No priceLevel? The estimated cost ("€15 pp") is the same information
            // in the same slot — the card's price line shows whichever we have.
            String price = JsCompat.jsTrim(p.priceLevel());
            if (price.isEmpty()) {
                price = JsCompat.jsTrim(p.cost());
            }
            out.add(new Recommendation(
                    messageId + ":s" + index,
                    p.name(),
                    coerceType(p.category()),
                    p.lat(),
                    p.lng(),
                    JsCompat.jsTrim(p.city()).isEmpty() ? null : p.city(),
                    JsCompat.jsTrim(p.description()).isEmpty() ? null : p.description(),
                    p.rating(),
                    null,
                    price.isEmpty() ? null : price,
                    JsCompat.jsTrim(p.source()).isEmpty() ? null : p.source(),
                    null,
                    null,
                    null));
            index++;
        }
        return out;
    }

    private record AssistantEntry(String content, AiReply structured, List<Recommendation> items) {
    }

    private static final int ASSISTANT_CACHE_LIMIT = 512;
    private static final Map<String, AssistantEntry> ASSISTANT_CACHE = new LinkedHashMap<>();

    /**
     * Card items for one assistant message, whichever format it was written
     * in. Identity-cached: an unchanged message hands back the exact same item
     * objects so downstream memos can bail out. Callers must treat the result
     * as read-only.
     */
    public static List<Recommendation> itemsForAssistant(String messageId, String content, AiReply structured) {
        synchronized (ASSISTANT_CACHE) {
            AssistantEntry hit = ASSISTANT_CACHE.get(messageId);
            if (hit != null && Objects.equals(hit.content(), content)
                    && Objects.equals(hit.structured(), structured)) {
                return hit.items();
            }

            List<Recommendation> items = structured != null
                    ? itemsFromStructured(messageId, structured)
                    : itemsForMessage(messageId, content);

            if (hit == null && ASSISTANT_CACHE.size() >= ASSISTANT_CACHE_LIMIT) {
                Iterator<String> oldest = ASSISTANT_CACHE.keySet().iterator();
                if (oldest.hasNext()) {
                    oldest.next();
                    oldest.remove();
                }
            }
            ASSISTANT_CACHE.put(messageId, new AssistantEntry(content, structured, items));
            return items;
        }
    }

    private static List<Recommendation> lastCollect = List.of();

    public static List<Recommendation> collectRecommendations(List<ChatMessage> messages) {
        List<Recommendation> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (ChatMessage msg : messages) {
            if (!"assistant".equals(msg.role())) {
                continue;
            }
            for (Recommendation item : itemsForAssistant(msg.id(), msg.content(), msg.structured())) {
                if (!seen.add(item.id())) {
                    continue;
                }
                out.add(item);
            }
        }
        // Identity-stable: streaming re-creates the messages array every token,
        // but the derived items are cached — when nothing actually changed,
        // hand back the previous array so downstream memos skip.
        if (lastCollect.size() == out.size() && sameInstances(lastCollect, out)) {
            return lastCollect;
        }
        lastCollect = out;
        return out;
    }

    private static List<Recommendation> lastMerged = List.of();

    /**
     * Chat cards + stage-enriched extras, deduped by name. Returns a
     * reference-stable array when the merged list is element-wise identical to
     * the previous call.
     */
    public static List<Recommendation> mergeRecommendations(List<Recommendation> base, List<Recommendation> extras) {
        if (extras.isEmpty()) {
            return base;
        }
        Set<String> seen = new HashSet<>();
        List<Recommendation> merged = new ArrayList<>(base);
        for (Recommendation r : base) {
            seen.add(JsCompat.jsLowerCase(r.name()));
        }
        for (Recommendation h : extras) {
            String key = JsCompat.jsLowerCase(h.name());
            if (!seen.contains(key)) {
                seen.add(key);
                merged.add(h);
            }
        }
        if (lastMerged.size() == merged.size() && sameInstances(lastMerged, merged)) {
            return lastMerged;
        }
        lastMerged = merged;
        return merged;
    }

    private static boolean sameInstances(List<Recommendation> a, List<Recommendation> b) {
        for (int i = 0; i < a.size(); i++) {
            if (a.get(i) != b.get(i)) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------- destinations

    private static final Pattern DEST_IN = Pattern.compile(
            "\\bhotels?\\s+(?:in|near|at|around|downtown|city\\s+center\\s+in)\\s+([A-Za-z][A-Za-z\\s'-]{2,40})",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern DEST_TO = Pattern.compile(
            "\\b(?:trip|travel|visit|vacation|holiday|itinerary|stay)\\s+(?:to|in)\\s+([A-Za-z][A-Za-z\\s'-]{2,40})",
            Pattern.CASE_INSENSITIVE);
    /** Deliberately case-sensitive — the TS pattern has no {@code i} flag. */
    private static final Pattern DEST_CAPITAL = Pattern.compile(
            "\\bin\\s+([A-Z][a-zA-Z\\s'-]{2,40})");
    private static final Pattern DEST_CUT = Pattern.compile(
            "\\s+(?:for|and|with|during|that|this)\\s+[^\\n]*\\z", Pattern.CASE_INSENSITIVE);
    private static final Pattern DEST_SPLIT = Pattern.compile("[.?,!;\\n]");

    public static String extractDestination(String... texts) {
        StringBuilder joined = new StringBuilder();
        for (String t : texts) {
            if (t != null && !t.isEmpty()) {
                if (joined.length() > 0) {
                    joined.append('\n');
                }
                joined.append(t);
            }
        }
        String j = joined.toString();
        for (Pattern p : List.of(DEST_IN, DEST_TO, DEST_CAPITAL)) {
            Matcher m = p.matcher(j);
            if (m.find() && m.group(1) != null) {
                String cleaned = DEST_SPLIT.split(m.group(1))[0];
                cleaned = DEST_CUT.matcher(cleaned).replaceFirst("");
                cleaned = JsCompat.jsTrim(cleaned);
                if (cleaned.length() >= 3) {
                    return cleaned;
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------- markdown

    private static boolean isBlockStart(String line) {
        if (line.isEmpty()) {
            return false;
        }
        if (line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) {
            return true;
        }
        if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) {
            return true;
        }
        if (Pattern.compile("^\\d+\\.\\s").matcher(line).find()) {
            return true;
        }
        return line.startsWith("---") || line.startsWith("===");
    }

    /**
     * Split markdown into a stable prefix (complete blocks, safe to render as
     * markdown) and a tail (incomplete block shown as plain text while typing).
     * Fence-aware: never splits inside an open ``` block. Also commits at
     * common block boundaries so streaming causes less reflow.
     */
    public static MarkdownSplit partitionMarkdown(String md) {
        boolean inFence = false;
        int openFenceAt = -1;
        int lastBoundary = 0;

        for (int i = 0; i < md.length(); i++) {
            char ch = md.charAt(i);

            if (ch == '`' && backtickAt(md, i + 1) && backtickAt(md, i + 2)
                    && (i == 0 || md.charAt(i - 1) == '\n')) {
                if (!inFence) {
                    inFence = true;
                    openFenceAt = i;
                } else {
                    inFence = false;
                    openFenceAt = -1;
                }
                i += 2;
                continue;
            }

            if (ch == '\n') {
                int nextLineStart = i + 1;
                if (!inFence) {
                    if (i + 1 < md.length() && md.charAt(i + 1) == '\n') {
                        lastBoundary = nextLineStart + 1;
                    } else if (nextLineStart < md.length() && isBlockStart(md.substring(nextLineStart))) {
                        lastBoundary = nextLineStart;
                    }
                }
            }
        }

        if (inFence && openFenceAt >= 0) {
            int before = md.lastIndexOf("\n\n", openFenceAt);
            int beforeLine = md.lastIndexOf("\n", openFenceAt);
            lastBoundary = Math.max(before == -1 ? 0 : before + 2, beforeLine == -1 ? 0 : beforeLine + 1);
        }

        return new MarkdownSplit(md.substring(0, lastBoundary), md.substring(lastBoundary));
    }

    private static boolean backtickAt(String s, int idx) {
        return idx >= 0 && idx < s.length() && s.charAt(idx) == '`';
    }

    // ------------------------------------------------------------ hotels

    /** Map-search hotel result → in-app detail sheet recommendation. */
    public static Recommendation hotelToRec(Hotel h) {
        return new Recommendation(
                "hotel-" + Js.numStr(h.id()),
                h.name(),
                RecType.HOTEL,
                h.lat(),
                h.lng(),
                null,
                h.address(),
                (double) h.stars(),
                null,
                "$" + h.pricePerNight(),
                null,
                null,
                null,
                h.website());
    }
}
