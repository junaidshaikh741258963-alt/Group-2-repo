package com.tripcraft.backend.chat;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Json;

/**
 * Structured AI reply contract — the zod-equivalent validator from
 * {@code aiSchema.ts}.
 *
 * <p>The model must answer with ONE JSON object:
 *
 * <pre>
 *   { intro, destination, dates, places[], itinerary[], followUpQuestion,
 *     suggestions[] }
 * </pre>
 *
 * <p>Ported semantics (they matter):
 *
 * <ul>
 *   <li>{@code str()} collapses anything the model emits into a bounded
 *       string; {@code min} stays strict so a genuinely missing required key
 *       ({@code name}, {@code title}, {@code intro}) still fails and triggers
 *       the correction retry. Optional strings become {@code ""} — never
 *       {@code null} — because the global {@code non_null} Jackson inclusion
 *       would drop a null key while the TS always emits it.</li>
 *   <li>{@code optNum()} (lat / lng / rating) treats {@code null}, {@code ""}
 *       and a missing key as "unknown": the field is OMITTED (stays null and
 *       is annotated {@link JsonInclude#NON_NULL}), never defaulted. Any other
 *       garbage fails just that CARD, not the whole reply.</li>
 *   <li>{@code tolerantArray()} drops malformed entries; the reply only fails
 *       (and triggers the retry) when *every* entry was unusable, carrying the
 *       first entry's issues into the message.</li>
 * </ul>
 */
public final class AiSchema {

    /** The four card categories the renderer knows how to dress. */
    public static final List<String> PLACE_CATEGORIES =
            List.of("destination", "attraction", "restaurant", "hotel");

    private AiSchema() {
    }

    // ------------------------------------------------------------- types

    /** One recommendation card. Optional numbers are omitted, never defaulted. */
    public record StructuredPlace(
            String name,
            String category,
            String city,
            @JsonInclude(JsonInclude.Include.NON_NULL) Double lat,
            @JsonInclude(JsonInclude.Include.NON_NULL) Double lng,
            String description,
            @JsonInclude(JsonInclude.Include.NON_NULL) Double rating,
            String priceLevel,
            String duration,
            String cost,
            String source) {
    }

    /** One itinerary stop. */
    public record ItineraryItem(
            String time,
            String title,
            String description,
            String place,
            String duration,
            String cost) {
    }

    /** One itinerary day. */
    public record ItineraryDay(Integer day, String title, List<ItineraryItem> items) {
    }

    /**
     * The validated, normalised reply. Every string key is guaranteed non-null
     * (empty string when unknown) so the reply ALWAYS serialises every key
     * under the global {@code non_null} inclusion policy.
     */
    public record AiReply(
            String intro,
            String destination,
            String dates,
            List<StructuredPlace> places,
            List<ItineraryDay> itinerary,
            String followUpQuestion,
            List<String> suggestions) {

        public AiReply withPlaces(List<StructuredPlace> places) {
            return new AiReply(intro, destination, dates, places, itinerary, followUpQuestion, suggestions);
        }

        public AiReply withItinerary(List<ItineraryDay> itinerary) {
            return new AiReply(intro, destination, dates, places, itinerary, followUpQuestion, suggestions);
        }

        public AiReply withIntro(String intro) {
            return new AiReply(intro, destination, dates, places, itinerary, followUpQuestion, suggestions);
        }
    }

    /** Result of {@link #parseAiReply}: either a reply or safe-to-retry errors. */
    public record ParseResult(boolean ok, AiReply reply, List<String> errors) {

        static ParseResult success(AiReply reply) {
            return new ParseResult(true, reply, List.of());
        }

        static ParseResult failure(List<String> errors) {
            return new ParseResult(false, null, List.copyOf(errors));
        }
    }

    // ------------------------------------------------------------- parse

    /**
     * Pull the reply object out of whatever the model produced: fenced or not,
     * leading chatter tolerated, trailing chatter ignored. String/escape aware
     * so a {@code }} inside a description can't truncate the object.
     */
    public static String extractJsonObject(String raw) {
        String text = Js.trim(raw == null ? "" : raw);
        text = TRAILING_FENCE.matcher(LEADING_FENCE.matcher(text).replaceFirst("")).replaceFirst("");
        text = Js.trim(text);
        int start = text.indexOf('{');
        if (start == -1) {
            return null;
        }

        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = start; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch == '\\') {
                    escaped = true;
                } else if (ch == '"') {
                    inString = false;
                }
                continue;
            }
            if (ch == '"') {
                inString = true;
            } else if (ch == '{') {
                depth++;
            } else if (ch == '}') {
                depth -= 1;
                if (depth == 0) {
                    return text.substring(start, i + 1);
                }
            }
        }
        return null;
    }

    private static final java.util.regex.Pattern LEADING_FENCE =
            java.util.regex.Pattern.compile("^```(?:json)?\\s*", java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final java.util.regex.Pattern TRAILING_FENCE =
            java.util.regex.Pattern.compile("\\s*```$", java.util.regex.Pattern.CASE_INSENSITIVE);

    private static String tidy(String s) {
        return Js.trim(Js.collapse(s));
    }

    /** Trim, de-duplicate and order what came back. Never mutates the input. */
    public static AiReply normalizeReply(AiReply reply) {
        Set<String> seen = new HashSet<>();
        List<StructuredPlace> places = new ArrayList<>();
        for (StructuredPlace p : reply.places()) {
            String key = Js.lower(tidy(p.name()));
            if (key.isEmpty() || seen.contains(key)) {
                continue;
            }
            seen.add(key);
            places.add(new StructuredPlace(
                    tidy(p.name()),
                    Js.lower(tidy(p.category())),
                    tidy(p.city()),
                    p.lat(),
                    p.lng(),
                    tidy(p.description()),
                    p.rating(),
                    tidy(p.priceLevel()),
                    tidy(p.duration()),
                    tidy(p.cost()),
                    tidy(p.source())));
        }

        List<ItineraryDay> days = new ArrayList<>();
        List<ItineraryDay> sortedDays = new ArrayList<>(reply.itinerary());
        sortedDays.sort(Comparator.comparingInt(d -> d.day() == null ? 0 : d.day()));
        for (ItineraryDay d : sortedDays) {
            List<ItineraryItem> items = new ArrayList<>();
            for (ItineraryItem it : d.items()) {
                items.add(new ItineraryItem(
                        tidy(it.time()),
                        tidy(it.title()),
                        tidy(it.description()),
                        tidy(it.place()),
                        tidy(it.duration()),
                        tidy(it.cost())));
            }
            days.add(new ItineraryDay(d.day(), tidy(d.title()), items));
        }

        List<String> suggestions = new ArrayList<>();
        for (String s : reply.suggestions()) {
            String v = tidy(s);
            if (!v.isEmpty() && !suggestions.contains(v)) {
                suggestions.add(v);
            }
            if (suggestions.size() >= 4) {
                break;
            }
        }

        return new AiReply(
                tidy(reply.intro()),
                tidy(reply.destination()),
                tidy(reply.dates()),
                places,
                days,
                tidy(reply.followUpQuestion()),
                suggestions);
    }

    /** Parse + validate a raw model reply. Errors are safe to feed back to a retry. */
    public static ParseResult parseAiReply(String raw) {
        String json = extractJsonObject(raw);
        if (json == null) {
            return ParseResult.failure(List.of("no JSON object found in the reply"));
        }

        JsonNode data;
        try {
            data = Json.M.readTree(json);
        } catch (Exception err) {
            String msg = err.getMessage() == null ? String.valueOf(err) : err.getMessage();
            return ParseResult.failure(List.of("JSON is malformed: " + Js.slice(msg, 0, 160)));
        }

        AiReply reply;
        try {
            reply = validateReply(data);
        } catch (Rejected rejected) {
            List<String> errors = new ArrayList<>();
            for (int i = 0; i < rejected.issues.size() && i < 8; i++) {
                errors.add(rejected.issues.get(i).format());
            }
            return ParseResult.failure(errors);
        }
        return ParseResult.success(normalizeReply(reply));
    }

    /** Human-readable (and model-readable) summary of why a reply was rejected. */
    public static String formatRejection(List<String> errors) {
        List<String> head = errors.size() > 6 ? errors.subList(0, 6) : errors;
        return String.join("; ", head);
    }

    // -------------------------------------------------------- validation

    /** One zod-style issue: dotted path + message ("root" when the path is empty). */
    private record Issue(List<String> path, String message) {

        String format() {
            String p = String.join(".", path);
            return (p.isEmpty() ? "root" : p) + ": " + message;
        }
    }

    /** Carries the collected issues out of a parse step. */
    private static final class Rejected extends RuntimeException {

        final List<Issue> issues;

        Rejected(List<Issue> issues) {
            super(null, null, false, false);
            this.issues = issues;
        }
    }

    @FunctionalInterface
    private interface ItemParser<T> {

        T parse(JsonNode item, List<Issue> issues);
    }

    private static AiReply validateReply(JsonNode data) {
        List<Issue> issues = new ArrayList<>();
        if (data == null || data.isNull() || !data.isObject()) {
            issues.add(new Issue(List.of(), "Expected object, received " + typeName(data)));
            throw new Rejected(issues);
        }

        String intro = strCheck(data, "intro", 800, 1, issues);
        String destination = strCheck(data, "destination", 90, 0, issues);
        String dates = strCheck(data, "dates", 90, 0, issues);
        List<StructuredPlace> places = tolerantArray(data, "places", 12, AiSchema::parsePlace, issues);
        List<ItineraryDay> itinerary = tolerantArray(data, "itinerary", 30, AiSchema::parseDay, issues);
        String followUpQuestion = strCheck(data, "followUpQuestion", 320, 0, issues);
        List<String> suggestions = tolerantArray(data, "suggestions", 4, AiSchema::parseSuggestion, issues);

        if (!issues.isEmpty()) {
            throw new Rejected(issues);
        }
        return new AiReply(intro, destination, dates, places, itinerary, followUpQuestion, suggestions);
    }

    private static StructuredPlace parsePlace(JsonNode v, List<Issue> issues) {
        List<Issue> local = new ArrayList<>();
        if (v == null || !v.isObject()) {
            issues.add(new Issue(List.of(), "Expected object, received " + typeName(v)));
            return null;
        }
        String name = strCheck(v, "name", 120, 1, local);
        String category = strCheck(v, "category", 32, 1, local);
        String city = strCheck(v, "city", 80, 0, local);
        Double lat = optNumField(v, "lat", -90, 90, local);
        Double lng = optNumField(v, "lng", -180, 180, local);
        String description = strCheck(v, "description", 220, 0, local);
        Double rating = optNumField(v, "rating", 0, 5, local);
        String priceLevel = strCheck(v, "priceLevel", 48, 0, local);
        String duration = strCheck(v, "duration", 48, 0, local);
        String cost = strCheck(v, "cost", 48, 0, local);
        String source = strCheck(v, "source", 80, 0, local);
        if (!local.isEmpty()) {
            issues.addAll(local);
            return null;
        }
        return new StructuredPlace(name, category, city, lat, lng, description, rating,
                priceLevel, duration, cost, source);
    }

    private static ItineraryItem parseItem(JsonNode v, List<Issue> issues) {
        List<Issue> local = new ArrayList<>();
        if (v == null || !v.isObject()) {
            issues.add(new Issue(List.of(), "Expected object, received " + typeName(v)));
            return null;
        }
        String time = strCheck(v, "time", 24, 0, local);
        String title = strCheck(v, "title", 140, 1, local);
        String description = strCheck(v, "description", 240, 0, local);
        String place = strCheck(v, "place", 140, 0, local);
        String duration = strCheck(v, "duration", 48, 0, local);
        String cost = strCheck(v, "cost", 48, 0, local);
        if (!local.isEmpty()) {
            issues.addAll(local);
            return null;
        }
        return new ItineraryItem(time, title, description, place, duration, cost);
    }

    private static ItineraryDay parseDay(JsonNode v, List<Issue> issues) {
        List<Issue> local = new ArrayList<>();
        if (v == null || !v.isObject()) {
            issues.add(new Issue(List.of(), "Expected object, received " + typeName(v)));
            return null;
        }
        Integer day = dayField(v, local);
        String title = strCheck(v, "title", 90, 0, local);
        List<ItineraryItem> items = tolerantArray(v, "items", 12, AiSchema::parseItem, local);
        if (!local.isEmpty()) {
            issues.addAll(local);
            return null;
        }
        return new ItineraryDay(day, title, items);
    }

    private static String parseSuggestion(JsonNode v, List<Issue> issues) {
        String s = str(v, 90);
        if (s.length() < 1) {
            issues.add(new Issue(List.of(), "String must contain at least 1 character(s)"));
        }
        return s;
    }

    /**
     * Element-wise array parsing: one malformed card must not cost the user the
     * other seven. Bad entries are dropped; the reply only fails (and triggers
     * the correction retry) when *every* entry was unusable.
     */
    private static <T> List<T> tolerantArray(JsonNode parent, String field, int max,
            ItemParser<T> parser, List<Issue> issues) {
        List<JsonNode> items = new ArrayList<>();
        JsonNode v = parent.get(field);
        if (v != null && v.isArray()) {
            for (JsonNode el : v) {
                if (items.size() >= max) {
                    break;
                }
                items.add(el);
            }
        }

        List<T> out = new ArrayList<>();
        List<Issue> firstIssues = null;
        for (JsonNode item : items) {
            List<Issue> itemIssues = new ArrayList<>();
            T parsed = parser.parse(item, itemIssues);
            if (itemIssues.isEmpty()) {
                out.add(parsed);
            } else if (firstIssues == null) {
                firstIssues = itemIssues;
            }
        }
        if (out.isEmpty() && !items.isEmpty()) {
            // Carry the first entry's actual issue into the message — without it
            // "every entry was unusable" is undiagnosable from a log line.
            String detail = "";
            if (firstIssues != null && !firstIssues.isEmpty()) {
                StringBuilder sb = new StringBuilder(" — first entry: ");
                for (int i = 0; i < firstIssues.size() && i < 3; i++) {
                    if (i > 0) {
                        sb.append(", ");
                    }
                    sb.append(firstIssues.get(i).format());
                }
                detail = sb.toString();
            }
            issues.add(new Issue(List.of(field),
                    "every entry was unusable (" + items.size() + " given, 0 valid)" + detail));
            return List.of();
        }
        return out;
    }

    /**
     * A string field that survives the shapes a model actually emits: numbers
     * and booleans stringify, arrays join scalars with " · ", objects join
     * scalar values with " – ", anything else becomes "". The result is
     * truncated to {@code max} (JS {@code slice} — UTF-16 code units).
     */
    private static String str(JsonNode v, int max) {
        String s;
        if (v == null || v.isNull()) {
            s = "";
        } else if (v.isTextual()) {
            s = v.asText();
        } else if (v.isNumber()) {
            s = Js.numberToString(v.doubleValue());
        } else if (v.isBoolean()) {
            s = v.asBoolean() ? "true" : "false";
        } else if (v.isArray()) {
            List<String> parts = new ArrayList<>();
            for (JsonNode e : v) {
                if (isScalar(e)) {
                    parts.add(scalarToString(e));
                }
            }
            s = String.join(" · ", parts);
        } else if (v.isObject()) {
            List<String> parts = new ArrayList<>();
            for (var entry : v.properties()) {
                if (isScalar(entry.getValue())) {
                    parts.add(scalarToString(entry.getValue()));
                }
            }
            s = String.join(" – ", parts);
        } else {
            s = "";
        }
        return s.length() > max ? Js.slice(s, 0, max) : s;
    }

    private static boolean isScalar(JsonNode v) {
        return v.isTextual() || v.isNumber() || v.isBoolean();
    }

    private static String scalarToString(JsonNode v) {
        if (v.isTextual()) {
            return v.asText();
        }
        if (v.isNumber()) {
            return Js.numberToString(v.doubleValue());
        }
        return v.asBoolean() ? "true" : "false";
    }

    /** {@code str(max, min)} as applied to a named field of an object. */
    private static String strCheck(JsonNode parent, String field, int max, int min, List<Issue> issues) {
        String s = str(parent.get(field), max);
        if (s.length() < min) {
            issues.add(new Issue(List.of(field), "String must contain at least " + min + " character(s)"));
        }
        return s;
    }

    /** Outcome of the zod {@code num()} preprocess step. */
    private record NumResult(boolean unknown, boolean isNumber, double value, JsonNode raw) {
    }

    /**
     * zod {@code num()} preprocess: strings parse (first comma → dot),
     * {@code null}/{@code undefined}/{@code ""} mean "unknown", finite numbers
     * pass through, anything else stays the raw value and fails the number
     * check with an invalid_type issue.
     */
    private static NumResult numPreprocess(JsonNode v) {
        if (v == null || v.isNull() || (v.isTextual() && v.asText().isEmpty())) {
            return new NumResult(true, false, 0, null);
        }
        if (v.isNumber()) {
            return new NumResult(false, true, v.doubleValue(), null);
        }
        if (v.isTextual()) {
            double n = Js.parseFloat(v.asText().replaceFirst(",", "."));
            if (!Double.isNaN(n)) {
                return new NumResult(false, true, n, null);
            }
            return new NumResult(false, false, 0, v);
        }
        return new NumResult(false, false, 0, v);
    }

    /** {@code optNum(min, max)}: null/""/missing collapse to "no value" (omitted). */
    private static Double optNumField(JsonNode parent, String field, double min, double max, List<Issue> issues) {
        NumResult r = numPreprocess(parent.get(field));
        if (r.unknown()) {
            return null;
        }
        if (!r.isNumber()) {
            issues.add(new Issue(List.of(field), "Expected number, received " + typeName(r.raw())));
            return null;
        }
        double val = r.value();
        if (val < min) {
            issues.add(new Issue(List.of(field), "Number must be greater than or equal to " + Js.numberToString(min)));
        }
        if (val > max) {
            issues.add(new Issue(List.of(field), "Number must be less than or equal to " + Js.numberToString(max)));
        }
        return val;
    }

    /** Required int field with zod {@code z.number().int().min(min).max(max)} semantics. */
    private static Integer intField(JsonNode parent, String field, int min, int max, List<Issue> issues) {
        NumResult r = numPreprocess(parent.get(field));
        if (r.unknown()) {
            issues.add(new Issue(List.of(field), "Required"));
            return null;
        }
        if (!r.isNumber()) {
            issues.add(new Issue(List.of(field), "Expected number, received " + typeName(r.raw())));
            return null;
        }
        double rounded = Math.round(r.value()); // JS Math.round: half up toward +Infinity
        if (rounded < min) {
            issues.add(new Issue(List.of(field), "Number must be greater than or equal to " + min));
        }
        if (rounded > max) {
            issues.add(new Issue(List.of(field), "Number must be less than or equal to " + max));
        }
        return (int) rounded;
    }

    private static Integer dayField(JsonNode parent, List<Issue> issues) {
        return intField(parent, "day", 1, 60, issues);
    }

    /** JS {@code typeof} for the invalid_type messages. */
    private static String typeName(JsonNode v) {
        if (v == null || v.isMissingNode() || v.isNull()) {
            return "null";
        }
        if (v.isTextual()) {
            return "string";
        }
        if (v.isNumber()) {
            return "number";
        }
        if (v.isBoolean()) {
            return "boolean";
        }
        if (v.isArray()) {
            return "array";
        }
        return "object";
    }
}
