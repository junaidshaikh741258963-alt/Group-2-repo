package com.tripcraft.backend.trains;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.trains.Trains.StationSuggestion;
import com.tripcraft.backend.trains.Trains.TrainJourney;
import com.tripcraft.backend.trains.Trains.TrainLeg;

import static com.tripcraft.backend.trains.Trains.encodeComponent;
import static com.tripcraft.backend.trains.Trains.jsNumberValue;
import static com.tripcraft.backend.trains.Trains.normalize;
import static com.tripcraft.backend.trains.Trains.numText;
import static com.tripcraft.backend.trains.Trains.orEmpty;
import static com.tripcraft.backend.trains.Trains.slice;
import static com.tripcraft.backend.trains.Trains.text;
import static com.tripcraft.backend.trains.Trains.truthy;

/**
 * Port of {@code src/lib/indiaRail.ts} — keyless Indian Railways access:
 *
 * <ul>
 *   <li>ConfirmTkt's public web API (their own frontend constants, no account)</li>
 *   <li>eRail's tilde-delimited feed as a fallback</li>
 * </ul>
 *
 * Both are unofficial, best-effort feeds rather than IRCTC partner APIs.
 */
public final class IndiaRail {

    private static final Logger log = LoggerFactory.getLogger(IndiaRail.class);

    private static final String CT_HOST = "https://cttrainsapi.confirmtkt.com";
    private static final String ERAIL_HOST = "https://erail.in";
    private static final int TIMEOUT_MS = 20000;

    /**
     * Their own frontend constants (no account needed). {@code User-Agent} is
     * already {@code TripCraft/1.0} in infra.Http; ConfirmTkt tolerates the
     * second {@code Accept} line — verified live.
     */
    private static final Map<String, String> CT_HEADERS = Map.of(
            "Accept", "application/json",
            "clientid", "ct-web",
            "apikey", "ct-web!2$",
            "deviceid", "tripcraft-0000-0000-0000-000000000000");

    /**
     * eRail answers {@code 400 Bad Request} for duplicate headers, and
     * {@code infra.Http} always adds its own wildcard Accept header plus
     * {@code User-Agent: TripCraft/1.0}, so nothing extra is declared here:
     * that exact single-line request was verified live against eRail.
     */
    private static final Map<String, String> BROWSER_HEADERS = Map.of();

    private static final Pattern CLOCK_DOTTED = Pattern.compile("^(\\d{1,2})[:.](\\d{1,2})$");
    private static final Pattern CLOCK_PLAIN = Pattern.compile("^\\d{2}:\\d{2}$");
    private static final Pattern TRAIN_NUMBER = Pattern.compile("^\\d{4,6}$");
    private static final Pattern ALL_STATIONS = Pattern.compile("all stations", Pattern.CASE_INSENSITIVE);
    private static final Pattern CODE_3_6 = Pattern.compile("^[A-Za-z]{3,6}$");
    private static final Pattern DOTTED_DURATION = Pattern.compile("^(\\d{1,3})[.](\\d{2})$");
    private static final Pattern SPACED_DURATION = Pattern.compile("^(\\d{1,3})h\\s*(\\d{1,2})m?$", Pattern.CASE_INSENSITIVE);

    private IndiaRail() {
    }

    /** Indian station autocomplete (validated so non-Indian queries come back empty). */
    public static List<StationSuggestion> suggestIndiaStations(String query, int limit) {
        String q = normalize(query);
        if (q.length() < 2) {
            return List.of();
        }

        String url = CT_HOST + "/api/v2/trains/stations/auto-suggestion"
                + "?searchString=" + encodeComponent(orEmpty(query).trim())
                + "&sourceStnCode=&popularStnListLimit=15&preferredStnListLimit=6"
                + "&channel=mwebd&language=EN";

        Http.Raw res = Http.get(url, CT_HEADERS, TIMEOUT_MS);
        if (!res.ok()) {
            throw upstreamError("Indian station search", res.status());
        }

        JsonNode json = res.json();
        JsonNode list = Json.arrOr(child(json, "data"), "stationList");

        List<StationSuggestion> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode s : Json.elements(list)) {
            String code = orEmpty(text(s, "stationCode")).trim().toUpperCase(Locale.ROOT);
            if (code.isEmpty() || seen.contains(code)) {
                continue;
            }
            if (ALL_STATIONS.matcher(orEmpty(text(s, "stationName"))).find()) {
                continue;
            }
            if (!matchesQuery(q, s)) {
                continue;
            }
            seen.add(code);
            double lat = Trains.jsNumber(s, "latitude");
            double lng = Trains.jsNumber(s, "longitude");
            String name = truthy(text(s, "stationName"));
            out.add(new StationSuggestion(
                    "IN:" + code,
                    (name != null ? name : code).trim() + " (" + code + ")",
                    "station",
                    Double.isFinite(lat) ? lat : null,
                    Double.isFinite(lng) ? lng : null));
            if (out.size() >= limit) {
                break;
            }
        }
        return out;
    }

    /** Indian station code from a typed name or an {@code IN:CODE} id. */
    public static String resolveIndiaStation(String raw) {
        String value = orEmpty(raw).trim();
        if (value.isEmpty()) {
            return null;
        }
        if (value.toUpperCase(Locale.ROOT).startsWith("IN:")) {
            return value.substring(3).toUpperCase(Locale.ROOT);
        }
        if (CODE_3_6.matcher(value).matches()) {
            String wanted = "IN:" + value.toUpperCase(Locale.ROOT);
            for (StationSuggestion s : suggestIndiaStations(value, 6)) {
                if (wanted.equals(s.id())) {
                    return s.id().substring(3);
                }
            }
            return null;
        }
        List<StationSuggestion> matches = suggestIndiaStations(value, 1);
        return matches.isEmpty() ? null : matches.get(0).id().substring(3);
    }

    /** Direct trains between two Indian stations for a date (ConfirmTkt → eRail). */
    public static IndiaTrainSearch searchIndiaTrains(String fromCode, String toCode, String date) {
        if (fromCode.toUpperCase(Locale.ROOT).equals(toCode.toUpperCase(Locale.ROOT))) {
            throw new TrainSearchException("Origin and destination are the same station.");
        }

        String from = fromCode.toUpperCase(Locale.ROOT);
        String to = toCode.toUpperCase(Locale.ROOT);
        try {
            List<TrainJourney> trains = confirmTktTrains(from, to, date);
            if (!trains.isEmpty()) {
                return new IndiaTrainSearch(byDeparture(trains), "Indian Railways \u00b7 ConfirmTkt");
            }
        } catch (Exception err) {
            log.warn("ConfirmTkt search failed: {}", err.getMessage() == null ? err : err.getMessage());
        }

        List<TrainJourney> trains = erailTrains(from, to, date);
        return new IndiaTrainSearch(byDeparture(trains), "Indian Railways \u00b7 eRail");
    }

    /** What the route returns from this provider. */
    public record IndiaTrainSearch(List<TrainJourney> trains, String provider) {
    }

    // ----------------------------------------------------------- ConfirmTkt

    private static List<TrainJourney> confirmTktTrains(String fromCode, String toCode, String date) {
        String dd = slice(date, 8, 10);
        String mm = slice(date, 5, 7);
        String yyyy = slice(date, 0, 4);
        String url = CT_HOST + "/api/v1/trains/search"
                + "?sourceStationCode=" + encodeComponent(fromCode)
                + "&destinationStationCode=" + encodeComponent(toCode)
                + "&dateOfJourney=" + dd + "-" + mm + "-" + yyyy;

        Http.Raw res = Http.get(url, CT_HEADERS, TIMEOUT_MS);
        if (!res.ok()) {
            throw upstreamError("ConfirmTkt search", res.status());
        }

        JsonNode json = res.json();
        String message = truthy(text(child(json, "error"), "message"));
        if (message != null) {
            throw new TrainSearchException(message);
        }

        JsonNode list = Json.arrOr(child(json, "data"), "trainList");
        List<TrainJourney> out = new ArrayList<>();
        for (JsonNode t : Json.elements(list)) {
            String number = orEmpty(text(t, "trainNumber")).trim();
            String dep = normaliseClock(text(t, "departureTime"));
            String arr = normaliseClock(text(t, "arrivalTime"));
            if (number.isEmpty() || dep == null || arr == null) {
                continue;
            }
            double durationMin = parseDuration(t.get("duration"));
            if (durationMin == 0) {
                durationMin = BookingFormat.clockDiff(dep, arr);
            }

            Double fare = cheapestFare(t);
            String name = orEmpty(text(t, "trainName")).trim();
            out.add(buildJourney(
                    number,
                    name.isEmpty() ? number : name,
                    dep,
                    arr,
                    durationMin,
                    label(text(t, "fromStnName"), text(t, "fromStnCode"), fromCode),
                    label(text(t, "toStnName"), text(t, "toStnCode"), toCode),
                    date,
                    "Express",
                    fare,
                    fare != null ? "INR" : null));
        }
        return out;
    }

    /** "Name (CODE)" with the searched codes as the fallback the TS uses. */
    private static String label(String name, String stationCode, String fallback) {
        String place = truthy(name);
        String code = truthy(stationCode);
        return (place != null ? place : fallback).trim() + " (" + (code != null ? code : fallback).trim() + ")";
    }

    /** The cheapest positive fare across the availability cache, if any. */
    private static Double cheapestFare(JsonNode train) {
        JsonNode cache = train.get("availabilityCache");
        if (cache == null || !cache.isObject()) {
            return null;
        }

        List<String> classes = new ArrayList<>();
        JsonNode avl = train.get("avlClasses");
        if (avl != null && avl.isArray()) {
            for (JsonNode c : avl) {
                classes.add(c.asText());
            }
        } else {
            cache.fieldNames().forEachRemaining(classes::add);
        }

        Double best = null;
        for (String cls : classes) {
            JsonNode entry = cache.get(cls);
            double fare = jsNumberValue(entry == null || entry.isNull() ? null : entry.get("fare"));
            if (Double.isFinite(fare) && fare > 0 && (best == null || fare < best)) {
                best = fare;
            }
        }
        return best;
    }

    // ---------------------------------------------------------------- eRail

    private static List<TrainJourney> erailTrains(String fromCode, String toCode, String date) {
        String url = ERAIL_HOST + "/rail/getTrains.aspx?Station_From=" + encodeComponent(fromCode)
                + "&Station_To=" + encodeComponent(toCode) + "&DataSource=0&Language=0&Cache=true";

        Http.Raw res = Http.get(url, BROWSER_HEADERS, TIMEOUT_MS);
        if (!res.ok()) {
            throw upstreamError("eRail", res.status());
        }

        String body = res.body();
        String head = slice(body, 0, 300);
        if (headMatches(head, "Please try again after some time")) {
            throw new TrainSearchException("eRail is busy right now");
        }
        if (headMatches(head, "From station not found")) {
            throw new TrainSearchException("eRail does not know station " + fromCode);
        }
        if (headMatches(head, "To station not found")) {
            throw new TrainSearchException("eRail does not know station " + toCode);
        }
        if (headMatches(head, "No direct trains found")) {
            return List.of();
        }

        List<TrainJourney> out = new ArrayList<>();
        String[] chunks = body.split(Pattern.quote("~^"), -1);
        for (int i = 1; i < chunks.length; i++) {
            String[] f = chunks[i].split("~", -1);
            String number = (f.length > 0 ? f[0] : "").trim();
            if (!TRAIN_NUMBER.matcher(number).matches()) {
                continue;
            }
            String dep = f.length > 10 ? normaliseClock(f[10]) : null;
            String arr = f.length > 11 ? normaliseClock(f[11]) : null;
            if (dep == null || arr == null) {
                continue;
            }
            double durationMin = f.length > 12 ? parseDurationText(f[12]) : 0;
            if (durationMin == 0) {
                durationMin = BookingFormat.clockDiff(dep, arr);
            }
            String name = (f.length > 1 ? f[1] : number).trim();
            out.add(buildJourney(
                    number,
                    name,
                    dep,
                    arr,
                    durationMin,
                    field(f, 6, fromCode).trim() + " (" + field(f, 7, fromCode).trim() + ")",
                    field(f, 8, toCode).trim() + " (" + field(f, 9, toCode).trim() + ")",
                    date,
                    "Express",
                    null,
                    null));
        }
        return out;
    }

    // -------------------------------------------------------------- helpers

    /** Builds the single-ride journey both feeds describe. */
    private static TrainJourney buildJourney(String number, String name, String dep, String arr,
                                             double durationMin, String from, String to, String date,
                                             String product, Double price, String currency) {
        String departAt = date + " " + dep;
        String arriveAt = BookingFormat.arrivalStamp(date, dep, durationMin);
        if (arriveAt.isEmpty()) {
            arriveAt = date + " " + arr;
        }
        TrainLeg leg = new TrainLeg(
                "ride",
                (number + " \u00b7 " + name).trim(),
                product,
                name,
                to,
                from,
                to,
                departAt,
                arriveAt,
                durationMin);
        return new TrainJourney(departAt, arriveAt, durationMin, 0, from, to, price, currency, List.of(leg));
    }

    private static List<TrainJourney> byDeparture(List<TrainJourney> trains) {
        List<TrainJourney> copy = new ArrayList<>(trains);
        copy.sort(Comparator.comparing(TrainJourney::departAt));
        return copy;
    }

    private static boolean matchesQuery(String query, JsonNode station) {
        String code = normalize(text(station, "stationCode"));
        if (!code.isEmpty() && code.equals(query)) {
            return true;
        }
        if (normalize(text(station, "stationName")).startsWith(query)) {
            return true;
        }
        String city = normalize(text(station, "city"));
        return !city.isEmpty() && (city.startsWith(query) || city.contains(query));
    }

    /** "16.55" / "4:5" → "16:55" / "04:05"; {@code null} when unusable. */
    private static String normaliseClock(String value) {
        String raw = orEmpty(value).trim();
        Matcher m = CLOCK_DOTTED.matcher(raw);
        if (m.matches()) {
            int hh = Integer.parseInt(m.group(1));
            int mm = Integer.parseInt(m.group(2));
            if (hh > 23 || mm > 59) {
                return null;
            }
            return String.format(Locale.ROOT, "%02d:%02d", hh, mm);
        }
        return CLOCK_PLAIN.matcher(raw).matches() ? raw : null;
    }

    /** "15.40" (h.mm, eRail) or "15h 40m" → minutes; {@code 0} when unusable. */
    private static double parseDuration(JsonNode value) {
        if (value != null && value.isNumber()) {
            double minutes = value.asDouble();
            if (Double.isFinite(minutes) && minutes > 0) {
                return minutes;
            }
        }
        return parseDurationText(jsScalar(value));
    }

    private static double parseDurationText(String value) {
        String raw = orEmpty(value).trim();
        Matcher dotted = DOTTED_DURATION.matcher(raw);
        if (dotted.matches()) {
            return Integer.parseInt(dotted.group(1)) * 60 + Integer.parseInt(dotted.group(2));
        }
        Matcher spaced = SPACED_DURATION.matcher(raw);
        if (spaced.matches()) {
            return Integer.parseInt(spaced.group(1)) * 60 + Integer.parseInt(spaced.group(2));
        }
        double minutes = Trains.jsNumberText(raw);
        return Double.isFinite(minutes) && minutes > 0 ? minutes : 0;
    }

    /** JS {@code (value \|\| "").toString()}. */
    private static String jsScalar(JsonNode value) {
        if (value == null || value.isNull()) {
            return "";
        }
        if (value.isTextual()) {
            return value.asText();
        }
        if (value.isNumber()) {
            return numText(value.asDouble());
        }
        if (value.isBoolean()) {
            return value.asBoolean() ? "true" : "false";
        }
        return "";
    }

    /** eRail tilde fields fall back to the searched code when the slot is absent. */
    private static String field(String[] fields, int index, String fallback) {
        return index < fields.length ? fields[index] : fallback;
    }

    private static boolean headMatches(String head, String needle) {
        return head.toLowerCase(Locale.ROOT).contains(needle.toLowerCase(Locale.ROOT));
    }

    private static JsonNode child(JsonNode node, String field) {
        return node == null ? null : node.get(field);
    }

    /**
     * The TS fetch failure ("fetch failed" for a network error) versus the
     * {@code `${what} returned ${status}`} message for an HTTP error.
     */
    private static TrainSearchException upstreamError(String what, int status) {
        return new TrainSearchException(status == 0 ? "fetch failed" : what + " returned " + status);
    }
}
