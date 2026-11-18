package com.tripcraft.backend.api;

import java.net.URI;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.trains.BookingFormat;
import com.tripcraft.backend.trains.IndiaRail;
import com.tripcraft.backend.trains.IndiaRail.IndiaTrainSearch;
import com.tripcraft.backend.trains.TrainSearchException;
import com.tripcraft.backend.trains.Trains.StationSuggestion;
import com.tripcraft.backend.trains.Trains.TrainJourney;
import com.tripcraft.backend.trains.Trains.TrainLeg;
import com.tripcraft.backend.trains.UkRail;
import com.tripcraft.backend.trains.UkRail.UkTrainSearch;

import static com.tripcraft.backend.trains.Trains.encodeForm;
import static com.tripcraft.backend.trains.Trains.jsTruthy;
import static com.tripcraft.backend.trains.Trains.normalize;
import static com.tripcraft.backend.trains.Trains.numberOrNull;
import static com.tripcraft.backend.trains.Trains.orEmpty;
import static com.tripcraft.backend.trains.Trains.text;
import static com.tripcraft.backend.trains.Trains.truthy;

/**
 * Port of {@code src/app/api/trains/route.ts} — one {@code POST} that serves
 * both {@code action: "autocomplete"} and the train search itself.
 *
 * <p>Provider flow preserved: station ids pass through, anything else is
 * probed as a place name with India → UK → HAFAS (or the provider forced by an
 * {@code IN:}/{@code UK:} id prefix), and HAFAS journeys are simplified in the
 * route itself.
 */
@RestController
@RequestMapping("/api/trains")
public class TrainsController {

    private static final Logger log = LoggerFactory.getLogger(TrainsController.class);

    private static final String HAFAS_BASE =
            stripTrailingSlashes(envOr("HAFAS_BASE_URL", "https://v6.vbb.transport.rest"));
    private static final String HAFAS_TZ = envOr("HAFAS_TIMEZONE", "Europe/Berlin");
    private static final int TIMEOUT_MS = 15000;

    private static final String COVERAGE_HINT =
            "That station could not be found. We cover India, the UK and Europe (e.g. New Delhi, NDLS, London, Berlin).";

    private static final Pattern ISO_DAY = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");
    private static final Pattern CLOCK = Pattern.compile("^\\d{2}:\\d{2}$");
    private static final Pattern HAFAS_ID = Pattern.compile("^\\d{4,}$");

    // ------------------------------------------------------------------ POST

    @PostMapping
    public ResponseEntity<?> search(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = Json.parseOrNull(raw);
            if (body == null || body.isNull()) {
                // TS: `await req.json().catch(() => ({}))`.
                body = Json.obj();
            }

            if ("autocomplete".equals(text(body, "action"))) {
                String q = orEmpty(stringField(body, "q")).trim();
                ObjectNode res = Json.obj();
                ArrayNode suggestions = res.putArray("suggestions");
                if (q.length() >= 2) {
                    for (StationSuggestion suggestion : suggestStations(q)) {
                        suggestions.add(suggestion.toJson());
                    }
                }
                return ResponseEntity.ok(res);
            }

            String fromQuery = orEmpty(coalesce(body, "from", "departure")).trim();
            String toQuery = orEmpty(coalesce(body, "to", "arrival")).trim();
            if (fromQuery.isEmpty() || toQuery.isEmpty()) {
                ObjectNode res = Json.obj();
                res.put("error", "Pick a departure and an arrival station.");
                res.putArray("trains");
                return ResponseEntity.badRequest().body(res);
            }

            String date = isoDate(body, "date");
            if (date == null) {
                date = BookingFormat.isoDateInDays(1);
            }
            String time = exactClock(body, "time");
            if (time == null) {
                time = "09:00";
            }

            Resolved resolved = resolveRoute(fromQuery, toQuery);
            if (resolved == null) {
                ObjectNode res = Json.obj();
                res.put("error", COVERAGE_HINT);
                res.putArray("trains");
                return ResponseEntity.badRequest().body(res);
            }

            List<TrainJourney> trains;
            String provider;
            if ("india".equals(resolved.route())) {
                IndiaTrainSearch result = IndiaRail.searchIndiaTrains(
                        stripPrefix(resolved.fromId(), "IN:"),
                        stripPrefix(resolved.toId(), "IN:"),
                        date);
                trains = result.trains();
                provider = result.provider();
            } else if ("uk".equals(resolved.route())) {
                UkTrainSearch result = UkRail.searchUkJourneys(
                        stripPrefix(resolved.fromId(), "UK:"),
                        stripPrefix(resolved.toId(), "UK:"),
                        date,
                        time);
                trains = result.trains();
                provider = result.provider();
            } else {
                Map<String, String> params = new LinkedHashMap<>();
                params.put("from", resolved.fromId());
                params.put("to", resolved.toId());
                params.put("departure", BookingFormat.localIsoWithOffset(date, time, HAFAS_TZ));
                params.put("results", "6");
                params.put("stopovers", "false");
                params.put("remarks", "false");
                params.put("language", "en");

                JsonNode data = hafasGet("/journeys", params);
                trains = new ArrayList<>();
                for (JsonNode journey : Json.arrOr(data, "journeys")) {
                    TrainJourney simplified = simplifyJourney(journey);
                    if (simplified != null
                            && !simplified.departAt().isEmpty()
                            && !simplified.arriveAt().isEmpty()) {
                        trains.add(simplified);
                    }
                }
                provider = URI.create(HAFAS_BASE).getHost();
            }

            ObjectNode res = Json.obj();
            ArrayNode list = res.putArray("trains");
            for (TrainJourney journey : trains) {
                list.add(journey.toJson());
            }
            res.put("date", date);
            res.put("time", time);
            res.put("fromId", resolved.fromId());
            res.put("toId", resolved.toId());
            res.put("route", resolved.route());
            res.put("provider", provider);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Train search error:", err);
            ObjectNode res = Json.obj();
            String message = err.getMessage();
            res.put("error", message == null ? "Train search failed" : message);
            res.putArray("trains");
            return ResponseEntity.status(502).body(res);
        }
    }

    // ---------------------------------------------------------------- HAFAS

    /** {@code fetch} + {@code res.ok} against the HAFAS (transport.rest) endpoint. */
    private JsonNode hafasGet(String path, Map<String, String> params) {
        StringBuilder url = new StringBuilder(HAFAS_BASE).append(path);
        String separator = "?";
        for (Map.Entry<String, String> entry : params.entrySet()) {
            String value = entry.getValue();
            if (value == null || value.isEmpty()) {
                continue;
            }
            url.append(separator).append(encodeForm(entry.getKey()))
                    .append('=').append(encodeForm(value));
            separator = "&";
        }

        Http.Raw res = Http.get(url.toString(), Map.of("Accept", "application/json"), TIMEOUT_MS);
        if (!res.ok()) {
            String detail = "";
            JsonNode body = res.json();
            if (body != null) {
                String message = truthy(text(body, "message"));
                if (message == null) {
                    message = truthy(text(body, "hafasMessage"));
                }
                detail = orEmpty(message);
            }
            if (detail.isEmpty()) {
                // Network failures reject `fetch` in the TS; HTTP errors say which status.
                detail = res.status() == 0 ? "fetch failed" : "Train service returned " + res.status();
            }
            throw new TrainSearchException(detail);
        }

        JsonNode json = res.json();
        if (json == null) {
            // The TS `await res.json()` rejected — a message, never the payload.
            throw new TrainSearchException("Invalid JSON from train service");
        }
        return json;
    }

    /** HAFAS {@code /locations} — station ids pass through, names are resolved. */
    private List<StationSuggestion> searchStations(String query) {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("query", query);
        params.put("results", "8");
        params.put("poi", "false");
        params.put("addresses", "false");
        params.put("lines", "1");
        JsonNode data = hafasGet("/locations", params);

        List<StationSuggestion> out = new ArrayList<>();
        for (JsonNode s : Json.elements(data)) {
            JsonNode id = s.get("id");
            JsonNode name = s.get("name");
            if (id == null || !id.isTextual() || name == null || !name.isTextual()
                    || name.asText().trim().isEmpty()) {
                continue;
            }
            String type = text(s, "type");
            if (!"stop".equals(type) && !"station".equals(type)) {
                type = "stop";
            }
            out.add(new StationSuggestion(
                    id.asText(),
                    name.asText(),
                    type,
                    numberOrNull(s, "latitude"),
                    numberOrNull(s, "longitude")));
        }
        return out;
    }

    /** Station ids pass through; anything else is resolved as a place name. */
    private String resolveHafasStation(String raw) {
        String value = orEmpty(raw).trim();
        if (value.isEmpty()) {
            return "";
        }
        if (HAFAS_ID.matcher(value).matches()) {
            return value;
        }
        List<StationSuggestion> matches = searchStations(value);
        return matches.isEmpty() ? "" : matches.get(0).id();
    }

    // ----------------------------------------------------------- resolution

    /** Merges India + UK + HAFAS autocomplete, prefix matches first, deduped. */
    private List<StationSuggestion> suggestStations(String q) {
        List<List<StationSuggestion>> sources = new ArrayList<>(3);
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<CompletableFuture<List<StationSuggestion>>> futures = List.of(
                    CompletableFuture.supplyAsync(() -> IndiaRail.suggestIndiaStations(q, 4), executor),
                    CompletableFuture.supplyAsync(() -> UkRail.suggestUkStations(q, 3), executor),
                    CompletableFuture.supplyAsync(() -> searchStations(q), executor));
            for (CompletableFuture<List<StationSuggestion>> future : futures) {
                try {
                    // Promise.allSettled: a rejected source simply contributes nothing.
                    sources.add(future.join());
                } catch (CompletionException err) {
                    sources.add(null);
                }
            }
        }

        List<RankedSuggestion> merged = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        String nq = normalize(q);
        for (int order = 0; order < sources.size(); order++) {
            List<StationSuggestion> source = sources.get(order);
            if (source == null) {
                continue;
            }
            for (StationSuggestion s : source) {
                if (s.id() == null || s.id().isEmpty() || !seen.add(s.id())) {
                    continue;
                }
                String label = normalize(s.name());
                String code = normalize(lastIdPart(s.id()));
                int score = label.startsWith(nq) || code.equals(nq) || code.startsWith(nq) ? 0 : 1;
                merged.add(new RankedSuggestion(s, score, order));
            }
        }

        merged.sort(Comparator.comparingInt(RankedSuggestion::score)
                .thenComparingInt(RankedSuggestion::order));
        List<StationSuggestion> out = new ArrayList<>();
        for (int i = 0; i < merged.size() && i < 8; i++) {
            out.add(merged.get(i).suggestion());
        }
        return out;
    }

    private record RankedSuggestion(StationSuggestion suggestion, int score, int order) {
    }

    private List<String> resolveBoth(String route, String fromQuery, String toQuery) {
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            CompletableFuture<String> from =
                    CompletableFuture.supplyAsync(() -> resolveStation(route, fromQuery), executor);
            CompletableFuture<String> to =
                    CompletableFuture.supplyAsync(() -> resolveStation(route, toQuery), executor);
            // Promise.all: the first rejection propagates with its own message.
            String fromId = join(from);
            String toId = join(to);
            if (truthy(fromId) == null || truthy(toId) == null) {
                return null;
            }
            return List.of(fromId, toId);
        }
    }

    private String resolveStation(String route, String raw) {
        return switch (route) {
            case "india" -> IndiaRail.resolveIndiaStation(raw);
            case "uk" -> UkRail.resolveUkStation(raw);
            default -> resolveHafasStation(raw);
        };
    }

    /** Picks the provider from id prefixes or by probing India → UK → HAFAS. */
    private Resolved resolveRoute(String fromQuery, String toQuery) {
        String fromUpper = fromQuery.toUpperCase(Locale.ROOT);
        String toUpper = toQuery.toUpperCase(Locale.ROOT);

        String forced = null;
        if (fromUpper.startsWith("IN:") || toUpper.startsWith("IN:")) {
            forced = "india";
        } else if (fromUpper.startsWith("UK:") || toUpper.startsWith("UK:")) {
            forced = "uk";
        } else if (fromQuery.contains(":") || toQuery.contains(":")) {
            forced = "hafas";
        }

        List<String> order = forced != null ? List.of(forced) : List.of("india", "uk", "hafas");
        for (String route : order) {
            List<String> resolved = resolveBoth(route, fromQuery, toQuery);
            if (resolved != null) {
                return new Resolved(route, resolved.get(0), resolved.get(1));
            }
        }
        return null;
    }

    private record Resolved(String route, String fromId, String toId) {
    }

    /** HAFAS journey → the shared wire shape (first/last leg drive the summary). */
    private static TrainJourney simplifyJourney(JsonNode journey) {
        List<JsonNode> legs = new ArrayList<>();
        for (JsonNode leg : Json.elements(journey.get("legs"))) {
            if (leg == null || leg.isNull()) {
                continue;
            }
            if (truthy(text(leg, "departure")) == null && truthy(text(leg, "arrival")) == null) {
                continue;
            }
            legs.add(leg);
        }
        if (legs.isEmpty()) {
            return null;
        }

        JsonNode first = legs.get(0);
        JsonNode last = legs.get(legs.size() - 1);
        int rides = 0;
        for (JsonNode leg : legs) {
            if (isRide(leg)) {
                rides++;
            }
        }

        String departAt = orEmpty(text(first, "departure"));
        String arriveAt = orEmpty(text(last, "arrival"));
        Long duration = BookingFormat.minutesBetween(departAt, arriveAt);
        double durationMin = duration == null ? 0 : duration;

        List<TrainLeg> simplifiedLegs = new ArrayList<>();
        for (JsonNode leg : legs) {
            String product = truthy(text(nested(leg, "line"), "product"));
            if (product == null) {
                product = truthy(text(nested(leg, "line"), "mode"));
            }
            Long legDuration = BookingFormat.minutesBetween(
                    orEmpty(text(leg, "departure")), orEmpty(text(leg, "arrival")));
            simplifiedLegs.add(new TrainLeg(
                    isRide(leg) ? "ride" : "walk",
                    orEmpty(text(nested(leg, "line"), "name")),
                    orEmpty(product),
                    orEmpty(text(nested(nested(leg, "line"), "operator"), "name")),
                    orEmpty(text(leg, "direction")),
                    orEmpty(text(nested(leg, "origin"), "name")),
                    orEmpty(text(nested(leg, "destination"), "name")),
                    orEmpty(text(leg, "departure")),
                    orEmpty(text(leg, "arrival")),
                    legDuration == null ? null : (double) legDuration));
        }

        JsonNode price = journey.get("price");
        if (price != null && !price.isObject()) {
            price = null;
        }
        String currency = price == null ? null : truthy(text(price, "currency"));

        return new TrainJourney(
                departAt,
                arriveAt,
                durationMin,
                Math.max(rides - 1, 0),
                orEmpty(text(nested(first, "origin"), "name")),
                orEmpty(text(nested(last, "destination"), "name")),
                numberOrNull(price, "amount"),
                currency,
                simplifiedLegs);
    }

    /** TS {@code leg.line && !leg.walking}. */
    private static boolean isRide(JsonNode leg) {
        return jsTruthy(leg.get("line")) && !jsTruthy(leg.get("walking"));
    }

    private static JsonNode nested(JsonNode node, String field) {
        return node == null ? null : node.get(field);
    }

    // -------------------------------------------------------------- helpers

    private static String join(CompletableFuture<String> future) {
        try {
            return future.join();
        } catch (CompletionException err) {
            Throwable cause = err.getCause();
            throw cause instanceof RuntimeException runtime ? runtime : err;
        }
    }

    /** TS {@code s.id.split(":").pop()}. */
    private static String lastIdPart(String id) {
        int colon = id.lastIndexOf(':');
        return colon >= 0 ? id.substring(colon + 1) : id;
    }

    /** TS {@code fromId.replace(/^IN:/i, "")}. */
    private static String stripPrefix(String id, String prefix) {
        return id.length() >= prefix.length() && id.regionMatches(true, 0, prefix, 0, prefix.length())
                ? id.substring(prefix.length())
                : id;
    }

    /** TS {@code String(body.a ?? body.b ?? "")}. */
    private static String coalesce(JsonNode body, String first, String second) {
        String value = stringField(body, first);
        if (value == null) {
            value = stringField(body, second);
        }
        return value == null ? "" : value;
    }

    /** {@code null} for undefined/null (nullish → fall through), else {@code String(value)}. */
    private static String stringField(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) {
            return null;
        }
        return jsString(v);
    }

    private static String jsString(JsonNode v) {
        if (v.isTextual()) {
            return v.asText();
        }
        if (v.isNumber() || v.isBoolean()) {
            return v.asText();
        }
        if (v.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode element : v) {
                if (sb.length() > 0) {
                    sb.append(',');
                }
                if (element != null && !element.isNull()) {
                    sb.append(jsString(element));
                }
            }
            return sb.toString();
        }
        return "[object Object]";
    }

    /** TS {@code typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)}. */
    private static String isoDate(JsonNode body, String field) {
        JsonNode v = body.get(field);
        if (v == null || !v.isTextual()) {
            return null;
        }
        String value = v.asText();
        return ISO_DAY.matcher(value).matches() ? value : null;
    }

    /** TS {@code typeof x === "string" && /^\d{2}:\d{2}$/.test(x)}. */
    private static String exactClock(JsonNode body, String field) {
        JsonNode v = body.get(field);
        if (v == null || !v.isTextual()) {
            return null;
        }
        String value = v.asText();
        return CLOCK.matcher(value).matches() ? value : null;
    }

    private static String envOr(String key, String fallback) {
        String value = EnvFile.get(key);
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static String stripTrailingSlashes(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }
}
