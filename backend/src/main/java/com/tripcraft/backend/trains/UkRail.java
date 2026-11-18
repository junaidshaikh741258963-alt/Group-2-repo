package com.tripcraft.backend.trains;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.trains.Trains.StationSuggestion;
import com.tripcraft.backend.trains.Trains.TrainJourney;
import com.tripcraft.backend.trains.Trains.TrainLeg;

import static com.tripcraft.backend.trains.Trains.encodeForm;
import static com.tripcraft.backend.trains.Trains.jsNumber;
import static com.tripcraft.backend.trains.Trains.normalize;
import static com.tripcraft.backend.trains.Trains.orEmpty;
import static com.tripcraft.backend.trains.Trains.text;
import static com.tripcraft.backend.trains.Trains.truthy;

/**
 * Port of {@code src/lib/ukRail.ts} — UK National Rail journey planning via
 * railinfo.uk, a free JSON API over Network Rail's open Darwin feed: no key
 * and no account required.
 */
public final class UkRail {

    private static final String HOST = "https://api.railinfo.uk";
    private static final int TIMEOUT_MS = 20000;

    private static final Pattern FOUR_DIGITS = Pattern.compile("^\\d{4}$");
    private static final Pattern CLOCK = Pattern.compile("^\\d{2}:\\d{2}$");
    private static final Pattern CODE_3 = Pattern.compile("^[A-Za-z]{3}$");

    private UkRail() {
    }

    /** UK station autocomplete — validated so non-UK queries come back empty. */
    public static List<StationSuggestion> suggestUkStations(String query, int limit) {
        String q = normalize(query);
        if (q.length() < 2) {
            return List.of();
        }

        Map<String, String> params = new LinkedHashMap<>();
        params.put("q", orEmpty(query).trim());
        JsonNode list = getJson("/stations", params);
        if (!list.isArray()) {
            return List.of();
        }

        List<StationSuggestion> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode s : Json.elements(list)) {
            String crs = orEmpty(text(s, "crs")).trim().toUpperCase(Locale.ROOT);
            String name = orEmpty(text(s, "description")).trim();
            if (crs.isEmpty() || name.isEmpty() || seen.contains(crs)) {
                continue;
            }
            boolean matchesCrs = crs.toLowerCase(Locale.ROOT).equals(q);
            boolean matchesName = normalize(name).startsWith(q);
            if (!matchesCrs && !matchesName) {
                continue;
            }
            seen.add(crs);
            out.add(new StationSuggestion("UK:" + crs, name + " (" + crs + ")", "station", null, null));
            if (out.size() >= limit) {
                break;
            }
        }
        return out;
    }

    /** UK station code from a typed name or a {@code UK:CRS} id. */
    public static String resolveUkStation(String raw) {
        String value = orEmpty(raw).trim();
        if (value.isEmpty()) {
            return null;
        }
        if (value.toUpperCase(Locale.ROOT).startsWith("UK:")) {
            return value.substring(3).toUpperCase(Locale.ROOT);
        }
        if (CODE_3.matcher(value).matches()) {
            return value.toUpperCase(Locale.ROOT);
        }
        List<StationSuggestion> matches = suggestUkStations(value, 1);
        return matches.isEmpty() ? null : matches.get(0).id().substring(3);
    }

    /** Direct journeys between two UK stations for a date and departure time. */
    public static UkTrainSearch searchUkJourneys(String fromCrs, String toCrs, String date, String time) {
        if (fromCrs.toUpperCase(Locale.ROOT).equals(toCrs.toUpperCase(Locale.ROOT))) {
            throw new TrainSearchException("Origin and destination are the same station.");
        }

        Map<String, String> params = new LinkedHashMap<>();
        params.put("from", fromCrs.toUpperCase(Locale.ROOT));
        params.put("to", toCrs.toUpperCase(Locale.ROOT));
        params.put("date", date);
        params.put("time", time.replace(":", ""));

        JsonNode data = getJson("/journeys", params);
        List<TrainJourney> trains = new ArrayList<>();
        for (JsonNode j : Json.arrOr(data, "journeys")) {
            TrainJourney journey = buildJourney(j, date);
            if (journey != null) {
                trains.add(journey);
            }
        }
        return new UkTrainSearch(trains, "UK National Rail");
    }

    /** What the route returns from this provider. */
    public record UkTrainSearch(List<TrainJourney> trains, String provider) {
    }

    // -------------------------------------------------------------- helpers

    private static JsonNode getJson(String path, Map<String, String> params) {
        StringBuilder url = new StringBuilder(HOST).append(path);
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
            throw new TrainSearchException(res.status() == 0
                    ? "fetch failed"
                    : "UK rail API returned " + res.status());
        }
        JsonNode json = res.json();
        if (json == null) {
            // The TS `await res.json()` rejected — a message, never the payload.
            throw new TrainSearchException("Invalid JSON from train service");
        }
        return json;
    }

    /** "1950" → "19:50". */
    private static String hhmm(String value) {
        String raw = orEmpty(value).trim();
        if (FOUR_DIGITS.matcher(raw).matches()) {
            int hh = Integer.parseInt(raw.substring(0, 2));
            int mm = Integer.parseInt(raw.substring(2, 4));
            if (hh > 23 || mm > 59) {
                return null;
            }
            return raw.substring(0, 2) + ":" + raw.substring(2, 4);
        }
        return CLOCK.matcher(raw).matches() ? raw : null;
    }

    private static TrainJourney buildJourney(JsonNode j, String date) {
        String dep = hhmm(text(j, "dep"));
        String arr = hhmm(text(j, "arr"));
        if (dep == null || arr == null) {
            return null;
        }

        double durationMin = jsNumber(j, "duration_min");
        if (!Double.isFinite(durationMin) || durationMin <= 0) {
            durationMin = BookingFormat.clockDiff(dep, arr);
        }

        List<JsonNode> rawLegs = new ArrayList<>();
        JsonNode legs = j.get("legs");
        if (legs != null && legs.isArray()) {
            legs.forEach(rawLegs::add);
        }

        List<TrainLeg> legList = new ArrayList<>();
        for (JsonNode leg : rawLegs) {
            String legDep = hhmm(text(leg, "dep"));
            String legArr = hhmm(text(leg, "arr"));
            if (legDep == null || legArr == null) {
                continue;
            }
            double legMin = BookingFormat.clockDiff(legDep, legArr);
            String line = truthy(text(leg, "atoc_code"));
            if (line == null) {
                line = truthy(text(leg, "headcode"));
            }
            legList.add(new TrainLeg(
                    "ride",
                    orEmpty(line).trim(),
                    "rail",
                    orEmpty(text(leg, "atoc_code")).trim(),
                    orEmpty(text(leg, "headcode")),
                    orEmpty(text(leg, "from_name")),
                    orEmpty(text(leg, "to_name")),
                    date + " " + legDep,
                    BookingFormat.arrivalStamp(date, legDep, legMin),
                    legMin));
        }

        String departAt = date + " " + dep;
        String arriveAt = BookingFormat.arrivalStamp(date, dep, durationMin);
        double changes = jsNumber(j, "changes");
        JsonNode first = rawLegs.isEmpty() ? null : rawLegs.get(0);
        JsonNode last = rawLegs.isEmpty() ? null : rawLegs.get(rawLegs.size() - 1);

        return new TrainJourney(
                departAt,
                arriveAt,
                durationMin,
                Double.isFinite(changes) ? changes : 0,
                orEmpty(text(first, "from_name")),
                orEmpty(text(last, "to_name")),
                null,
                null,
                legList);
    }
}
