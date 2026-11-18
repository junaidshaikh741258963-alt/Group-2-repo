package com.tripcraft.backend.api;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.flights.Airports;
import com.tripcraft.backend.flights.Airports.AirportRef;
import com.tripcraft.backend.flights.Airports.AirportSuggestion;
import com.tripcraft.backend.flights.FlightOffers.FlightLeg;
import com.tripcraft.backend.flights.FlightOffers.FlightOffer;
import com.tripcraft.backend.flights.OctoTrip;
import com.tripcraft.backend.infra.Json;

import static com.tripcraft.backend.flights.FlightOffers.jsTruthy;
import static com.tripcraft.backend.flights.FlightOffers.numberOrNull;
import static com.tripcraft.backend.flights.FlightOffers.orEmpty;
import static com.tripcraft.backend.flights.FlightOffers.text;
import static com.tripcraft.backend.flights.FlightOffers.truthy;

/**
 * Port of {@code src/app/api/flights/route.ts} — one {@code POST} that serves
 * both {@code action: "autocomplete"} and the flight search itself.
 *
 * <p>Provider flow preserved: SerpAPI {@code google_flights} first (its key is
 * out of quota in this environment, so it usually answers {@code null}), then
 * the free OctoTrip MCP endpoint, then a 503 when both come back empty.
 */
@RestController
@RequestMapping("/api/flights")
public class FlightsController {

    private static final Logger log = LoggerFactory.getLogger(FlightsController.class);

    private static final Pattern CODE3 = Pattern.compile("[A-Za-z]{3}");
    private static final Pattern ISO_DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern COMBINING = Pattern.compile("[\u0300-\u036f]");

    private static final Map<String, String> AIRPORT_BY_CITY = Map.ofEntries(
            Map.entry("new york", "JFK"),
            Map.entry("nyc", "JFK"),
            Map.entry("manhattan", "JFK"),
            Map.entry("tokyo", "NRT"),
            Map.entry("tokyo japan", "NRT"),
            Map.entry("london", "LHR"),
            Map.entry("paris", "CDG"),
            Map.entry("los angeles", "LAX"),
            Map.entry("san francisco", "SFO"),
            Map.entry("chicago", "ORD"),
            Map.entry("miami", "MIA"),
            Map.entry("dubai", "DXB"),
            Map.entry("singapore", "SIN"),
            Map.entry("hong kong", "HKG"),
            Map.entry("bangkok", "BKK"),
            Map.entry("rome", "FCO"),
            Map.entry("barcelona", "BCN"),
            Map.entry("amsterdam", "AMS"),
            Map.entry("berlin", "BER"),
            Map.entry("sydney", "SYD"),
            Map.entry("toronto", "YYZ"),
            Map.entry("vancouver", "YVR"),
            Map.entry("delhi", "DEL"),
            Map.entry("mumbai", "BOM"),
            Map.entry("seoul", "ICN"),
            Map.entry("shanghai", "PVG"),
            Map.entry("beijing", "PEK"),
            Map.entry("kuala lumpur", "KUL"),
            Map.entry("bali", "DPS"),
            Map.entry("istanbul", "IST"),
            Map.entry("lisbon", "LIS"),
            Map.entry("madrid", "MAD"),
            Map.entry("munich", "MUC"),
            Map.entry("zurich", "ZRH"),
            Map.entry("venice", "VCE"),
            Map.entry("florence", "FLR"),
            Map.entry("athens", "ATH"),
            Map.entry("copenhagen", "CPH"),
            Map.entry("stockholm", "ARN"),
            Map.entry("oslo", "OSL"),
            Map.entry("helsinki", "HEL"),
            Map.entry("dublin", "DUB"),
            Map.entry("edinburgh", "EDI"),
            Map.entry("manchester", "MAN"),
            Map.entry("boston", "BOS"),
            Map.entry("washington", "IAD"),
            Map.entry("seattle", "SEA"),
            Map.entry("denver", "DEN"),
            Map.entry("atlanta", "ATL"),
            Map.entry("dallas", "DFW"),
            Map.entry("houston", "IAH"),
            Map.entry("las vegas", "LAS"),
            Map.entry("orlando", "MCO"),
            Map.entry("honolulu", "HNL"),
            Map.entry("mexico city", "MEX"),
            Map.entry("buenos aires", "EZE"),
            Map.entry("sao paulo", "GRU"),
            Map.entry("cairo", "CAI"),
            Map.entry("nairobi", "NBO"),
            Map.entry("johannesburg", "JNB"),
            Map.entry("cape town", "CPT"),
            Map.entry("marrakech", "RAK"),
            Map.entry("tel aviv", "TLV"),
            Map.entry("doha", "DOH"),
            Map.entry("abu dhabi", "AUH"),
            Map.entry("taipei", "TPE"),
            Map.entry("manila", "MNL"),
            Map.entry("ho chi minh", "SGN"),
            Map.entry("hanoi", "HAN"),
            Map.entry("phuket", "HKT"),
            Map.entry("reykjavik", "KEF"),
            Map.entry("bogota", "BOG"),
            Map.entry("lima", "LIM"),
            Map.entry("santiago", "SCL"));

    private final SerpApiService serp;

    public FlightsController(SerpApiService serp) {
        this.serp = serp;
    }

    // ------------------------------------------------------------------ POST

    @PostMapping
    public ResponseEntity<?> search(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = Json.parseOrNull(raw);
            if (body == null || body.isNull()) {
                // TS: `await req.json()` rejects on bad/empty JSON, and
                // `body.action` on a parsed `null` throws — both land here.
                throw new IllegalArgumentException("Request body is not valid JSON");
            }

            if ("autocomplete".equals(stringField(body, "action"))) {
                String q = orEmpty(stringField(body, "q")).trim();
                ObjectNode res = Json.obj();
                ArrayNode suggestions = res.putArray("suggestions");
                if (q.length() >= 2) {
                    for (AirportSuggestion suggestion : fetchSuggestions(q)) {
                        suggestions.add(suggestion.toJson());
                    }
                }
                return ResponseEntity.ok(res);
            }

            String departure = resolveAirport(coalesce(body, "departure", "from"));
            String arrival = resolveAirport(coalesce(body, "arrival", "to"));
            if (truthy(departure) == null || truthy(arrival) == null) {
                ObjectNode res = Json.obj();
                res.put("error",
                        "Could not find that airport. Try a city, airport, or code (e.g. Paris, JFK).");
                res.putArray("flights");
                return ResponseEntity.badRequest().body(res);
            }

            String outboundDate = isoDate(body, "outboundDate");
            if (outboundDate == null) {
                outboundDate = isoInDays(14);
            }
            String returnDate = isoDate(body, "returnDate");

            double adults = 1;
            JsonNode adultsNode = body.get("adults");
            if (adultsNode != null && adultsNode.isNumber()
                    && adultsNode.asDouble() >= 1 && adultsNode.asDouble() <= 9) {
                adults = adultsNode.asDouble();
            }

            Map<String, Object> params = new LinkedHashMap<>();
            params.put("engine", "google_flights");
            params.put("departure_id", departure);
            params.put("arrival_id", arrival);
            params.put("outbound_date", outboundDate);
            if (returnDate != null) {
                params.put("return_date", returnDate);
            }
            params.put("type", returnDate != null ? 1 : 2);
            params.put("adults", numString(adults));
            params.put("currency", "USD");
            JsonNode data = serp.search(params);

            List<FlightOffer> best = new ArrayList<>();
            List<FlightOffer> other = new ArrayList<>();
            String provider = "Google Flights";

            if (jsTruthy(data)) {
                JsonNode bestRaw = Json.arrOr(data, "best_flights");
                JsonNode otherRaw = Json.arrOr(data, "other_flights");
                int index = 0;
                for (JsonNode offer : Json.elements(bestRaw)) {
                    if (index >= 5) {
                        break;
                    }
                    best.add(simplifyOffer(offer, "best"));
                    index++;
                }
                index = 0;
                for (JsonNode offer : Json.elements(otherRaw)) {
                    if (index >= 8) {
                        break;
                    }
                    other.add(simplifyOffer(offer, "other"));
                    index++;
                }
            } else {
                List<JsonNode> octo = OctoTrip.search(
                        departure, arrival, outboundDate, returnDate, adults, "USD");
                List<FlightOffer> mapped = new ArrayList<>();
                List<JsonNode> results = octo == null ? List.of() : octo;
                for (int i = 0; i < results.size(); i++) {
                    FlightOffer offer = OctoTrip.octoToOffer(results.get(i), i < 5 ? "best" : "other");
                    if (offer != null) {
                        mapped.add(offer);
                    }
                }
                if (mapped.isEmpty()) {
                    ObjectNode res = Json.obj();
                    res.put("error",
                            "Flight search is unavailable right now — both search providers are out of capacity. Try again in a bit.");
                    res.putArray("flights");
                    res.putArray("best");
                    res.putArray("other");
                    return ResponseEntity.status(503).body(res);
                }
                for (FlightOffer offer : mapped) {
                    if ("best".equals(offer.kind())) {
                        best.add(offer);
                    }
                }
                for (FlightOffer offer : mapped) {
                    if ("other".equals(offer.kind())) {
                        other.add(offer);
                    }
                }
                if (other.size() > 8) {
                    other = new ArrayList<>(other.subList(0, 8));
                }
                provider = "OctoTrip";
            }

            ObjectNode res = Json.obj();
            res.set("best", offersJson(best));
            res.set("other", offersJson(other));
            ArrayNode flights = res.putArray("flights");
            for (FlightOffer offer : best) {
                flights.add(offer.toJson());
            }
            for (FlightOffer offer : other) {
                flights.add(offer.toJson());
            }
            res.put("departure", departure);
            res.put("arrival", arrival);
            res.put("outboundDate", outboundDate);
            if (returnDate == null) {
                res.putNull("returnDate");
            } else {
                res.put("returnDate", returnDate);
            }
            res.put("provider", provider);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Flights search error:", err);
            ObjectNode res = Json.obj();
            res.put("error", "Flight search failed. Please try again.");
            res.putArray("flights");
            res.putArray("best");
            res.putArray("other");
            return ResponseEntity.status(500).body(res);
        }
    }

    // -------------------------------------------------------------- airports

    /** Quick static mapping first, then the bundled index, then autocomplete. */
    private String resolveAirport(String raw) {
        String quick = resolveAirportCode(raw);
        if (quick != null) {
            return quick;
        }
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return null;
        }
        String local = Airports.resolveLocalAirport(value);
        if (local != null) {
            return local;
        }

        List<AirportSuggestion> suggestions = fetchSuggestions(value);
        boolean strict = normalizeText(value).length() <= 3;
        List<Ranked> ranked = new ArrayList<>();
        for (AirportSuggestion suggestion : suggestions) {
            int score = matchScore(suggestion.title(), value);
            if (score <= 0) {
                continue;
            }
            if (strict && score != 2) {
                continue;
            }
            ranked.add(new Ranked(suggestion, score));
        }
        ranked.sort((a, b) -> Integer.compare(b.score(), a.score())); // stable, like JS sort

        for (Ranked candidate : ranked) {
            if (!candidate.suggestion().airports().isEmpty()) {
                return candidate.suggestion().airports().get(0).code();
            }
        }
        return ranked.isEmpty() ? null : ranked.get(0).suggestion().id();
    }

    private record Ranked(AirportSuggestion suggestion, int score) {
    }

    private static String resolveAirportCode(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return null;
        }
        if (CODE3.matcher(value).matches()) {
            return value.toUpperCase(Locale.ROOT);
        }
        if (value.startsWith("/m/") || value.startsWith("/g/")) {
            return value;
        }
        String lower = value.toLowerCase(Locale.ROOT);
        String hit = AIRPORT_BY_CITY.get(lower);
        if (hit != null) {
            return hit;
        }
        int comma = lower.indexOf(',');
        String withoutCountry = (comma >= 0 ? lower.substring(0, comma) : lower).trim();
        return AIRPORT_BY_CITY.get(withoutCountry);
    }

    private List<AirportSuggestion> fetchSuggestions(String q) {
        String sliced = q.length() > 80 ? q.substring(0, 80) : q;
        JsonNode data = serp.search(Map.of("engine", "google_flights_autocomplete", "q", sliced));
        List<AirportSuggestion> remote = normalizeSuggestions(data);
        if (!remote.isEmpty()) {
            return remote;
        }
        return Airports.searchLocalAirports(q, 8);
    }

    private static List<AirportSuggestion> normalizeSuggestions(JsonNode data) {
        List<AirportSuggestion> out = new ArrayList<>();
        for (JsonNode s : Json.elements(Json.arrOr(data, "suggestions"))) {
            JsonNode name = s.get("name");
            JsonNode id = s.get("id");
            if (name == null || !name.isTextual() || id == null || !id.isTextual()) {
                continue;
            }
            String type = text(s, "type");
            if ("region".equals(type)) {
                continue;
            }
            List<AirportRef> airports = new ArrayList<>();
            for (JsonNode a : Json.elements(s.get("airports"))) {
                JsonNode airportId = a.get("id");
                if (airportId == null || !airportId.isTextual()
                        || !CODE3.matcher(airportId.asText()).matches()) {
                    continue;
                }
                String airportName = text(a, "name");
                airports.add(new AirportRef(
                        airportId.asText().toUpperCase(Locale.ROOT),
                        airportName == null ? "" : airportName,
                        truthy(text(a, "distance"))));
            }
            out.add(new AirportSuggestion(
                    id.asText(),
                    name.asText(),
                    truthy(text(s, "description")),
                    type == null || type.isEmpty() ? "airport" : type,
                    airports.isEmpty() ? null : airports.get(0).code(),
                    airports));
        }
        return out;
    }

    /** SerpAPI flight offer → the shared wire shape (first/last leg drive the summary). */
    private static FlightOffer simplifyOffer(JsonNode offer, String kind) {
        JsonNode legsRaw = Json.arrOr(offer, "flights");
        JsonNode first = legsRaw.size() > 0 ? legsRaw.get(0) : null;
        JsonNode last = legsRaw.size() > 0 ? legsRaw.get(legsRaw.size() - 1) : null;

        Double price = numberOrNull(offer, "price");
        if (price == null) {
            price = numberOrNull(offer, "total_price");
        }
        Double durationMin = numberOrNull(offer, "total_duration");
        if (durationMin == null) {
            durationMin = numberOrNull(offer, "duration");
        }
        Double stops = numberOrNull(offer, "stops");
        if (stops == null) {
            stops = (double) Math.max(legsRaw.size() - 1, 0);
        }

        List<FlightLeg> legs = new ArrayList<>();
        for (JsonNode leg : Json.elements(legsRaw)) {
            legs.add(new FlightLeg(
                    orEmpty(nestedText(leg, "departure_airport", "id")),
                    orEmpty(nestedText(leg, "arrival_airport", "id")),
                    orEmpty(nestedText(leg, "departure_airport", "time")),
                    orEmpty(nestedText(leg, "arrival_airport", "time")),
                    orEmpty(text(leg, "airline")),
                    orEmpty(text(leg, "airline_logo")),
                    orEmpty(text(leg, "flight_number")),
                    numberOrNull(leg, "duration")));
        }

        String travelClass = truthy(text(first, "travel_class"));
        return new FlightOffer(
                kind,
                price,
                null,
                null,
                durationMin,
                stops,
                orEmpty(text(first, "airline")),
                orEmpty(text(first, "airline_logo")),
                travelClass == null ? "Economy" : travelClass,
                orEmpty(nestedText(first, "departure_airport", "time")),
                orEmpty(nestedText(last, "arrival_airport", "time")),
                orEmpty(nestedText(first, "departure_airport", "id")),
                orEmpty(nestedText(last, "arrival_airport", "id")),
                orEmpty(nestedText(first, "departure_airport", "name")),
                orEmpty(nestedText(last, "arrival_airport", "name")),
                legs);
    }

    // --------------------------------------------------------------- helpers

    private static ArrayNode offersJson(List<FlightOffer> offers) {
        ArrayNode arr = Json.arr();
        for (FlightOffer offer : offers) {
            arr.add(offer.toJson());
        }
        return arr;
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
        return ISO_DATE.matcher(value).matches() ? value : null;
    }

    private static String isoInDays(int days) {
        return LocalDate.now(ZoneOffset.UTC).plusDays(days).toString();
    }

    /** JS {@code String(number)}: whole numbers without a {@code .0} suffix. */
    private static String numString(double value) {
        if (value == Math.floor(value) && !Double.isInfinite(value)) {
            return Long.toString((long) value);
        }
        return String.valueOf(value);
    }

    private static String nestedText(JsonNode node, String parent, String field) {
        return node == null ? null : text(node.get(parent), field);
    }

    /** Route-local {@code normalizeText()} from the TS (lowercase, strip diacritics). */
    private static String normalizeText(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String s = value.toLowerCase(Locale.ROOT);
        s = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD);
        s = COMBINING.matcher(s).replaceAll("");
        return s.trim();
    }

    /** 2 = title starts with the query, 1 = contains it, 0 = unrelated. */
    private static int matchScore(String title, String query) {
        String t = normalizeText(title);
        String q = normalizeText(query);
        if (q.isEmpty()) {
            return 0;
        }
        if (t.startsWith(q)) {
            return 2;
        }
        if (t.contains(q)) {
            return 1;
        }
        return 0;
    }
}
