package com.tripcraft.backend.api;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
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
import com.tripcraft.backend.agentlib.AgentService;
import com.tripcraft.backend.agentlib.CurrencyTool;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Coord;
import com.tripcraft.backend.places.Js;
import com.tripcraft.backend.places.OsmPoint;
import com.tripcraft.backend.places.OsmService;

/**
 * Ports of the three {@code /api/agent*} POST routes:
 * <ul>
 *   <li>{@code src/app/api/agent/route.ts} — the full plan generator;</li>
 *   <li>{@code src/app/api/agent/places/route.ts} — step 2 of the plan builder;</li>
 *   <li>{@code src/app/api/agent/stays/route.ts} — step 1 of the plan builder.</li>
 * </ul>
 *
 * <p>SerpAPI answers {@code null} here (its key is out of quota), so every one
 * of these routes walks its free OpenStreetMap fallback exactly as the
 * TypeScript does — {@code {"places": []}} for a non-Tokyo destination is the
 * correct result, not a bug.
 */
@RestController
@RequestMapping("/api/agent")
public class AgentController {

    private static final Logger log = LoggerFactory.getLogger(AgentController.class);

    private static final Pattern ISO_DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);
    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_LOCAL_DATE;

    private final AgentService agent;
    private final SerpApiService serp;
    private final OsmService osm;
    private final CurrencyTool currencyTool;

    public AgentController(AgentService agent, SerpApiService serp, OsmService osm, CurrencyTool currencyTool) {
        this.agent = agent;
        this.serp = serp;
        this.osm = osm;
        this.currencyTool = currencyTool;
    }

    // ------------------------------------------------------------- /api/agent

    @PostMapping
    public ResponseEntity<?> plan(@RequestBody(required = false) String raw) {
        try {
            String apiKey = EnvFile.get("GEMINI_API_KEY");
            if (apiKey == null || apiKey.isEmpty()) {
                return ResponseEntity.status(500).body(
                        error("Gemini API key not configured. Set GEMINI_API_KEY in .env.local"));
            }

            JsonNode form = Json.parseOrNull(raw);
            if (form == null || form.isMissingNode()) {
                // TS: `await req.json()` rejects on invalid/empty JSON.
                throw new IllegalArgumentException("Request body is not valid JSON");
            }

            if (!Js.truthy(form.get("destination")) || !Js.truthy(form.get("startDate"))
                    || !Js.truthy(form.get("endDate"))) {
                return ResponseEntity.badRequest()
                        .body(error("Missing required fields: destination, startDate, endDate"));
            }

            JsonNode plan = agent.runAgent(form);
            ObjectNode res = Json.obj();
            res.set("plan", plan); // ObjectNode.set turns a null value into JSON null
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Agent error:", err);
            ObjectNode res = Json.obj();
            res.put("error", "Agent failed to generate travel plan");
            res.put("details", "Something went wrong while generating your plan. Please try again.");
            return ResponseEntity.status(500).body(res);
        }
    }

    // --------------------------------------------------- /api/agent/places

    @PostMapping("/places")
    public ResponseEntity<?> places(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = requireObjectBody(raw);

            String q0 = stringOr(body, "destination", "").trim();
            if (q0.isEmpty()) {
                return ResponseEntity.badRequest().body(error("destination required"));
            }

            List<String> interestList = new ArrayList<>();
            JsonNode interests = body.get("interests");
            if (interests != null && interests.isArray()) {
                for (JsonNode i : interests) {
                    if (i != null && i.isTextual() && !i.asText().trim().isEmpty()) {
                        interestList.add(i.asText());
                        if (interestList.size() >= 3) {
                            break;
                        }
                    }
                }
            }
            String focus = interestList.isEmpty() ? "" : " (" + String.join(", ", interestList) + ")";

            JsonNode data = serp.search(Map.of(
                    "engine", "google_maps",
                    "q", "top tourist attractions in " + q0,
                    "type", "search"));

            List<ObjectNode> places = new ArrayList<>();
            JsonNode localResults = data == null ? null : data.get("local_results");
            if (localResults != null && localResults.isArray()) {
                for (JsonNode p : localResults) {
                    ObjectNode mapped = mapPlace(p);
                    if (mapped != null) {
                        places.add(mapped);
                    }
                }
            }
            if (places.isEmpty()) {
                JsonNode one = data == null ? null : data.get("place_results");
                if (one != null && one.isObject()) {
                    ObjectNode mapped = mapPlace(one);
                    if (mapped != null) {
                        places.add(mapped);
                    }
                }
            }

            int limit = intLimit(body, "count", 10, 1, 20);

            // Free fallback (OpenStreetMap) when SerpAPI is missing, throttled, or empty.
            if (places.isEmpty()) {
                Coord center = osm.geocodeCenter(q0);
                if (center != null) {
                    for (OsmPoint p : osm.overpassNearby(center.lat(), center.lng(), "tourist attractions", 10, limit)) {
                        ObjectNode o = Json.obj();
                        o.put("name", p.name());
                        Json.putIfPresent(o, "type", p.category());
                        Json.putIfPresent(o, "address", p.address());
                        Json.putIfPresent(o, "openState", p.openingHours());
                        Js.putNum(o, "lat", p.lat());
                        Js.putNum(o, "lng", p.lng());
                        places.add(o);
                    }
                }
            }

            ObjectNode res = Json.obj();
            ArrayNode arr = res.putArray("places");
            for (int i = 0; i < places.size() && i < limit; i++) {
                arr.add(places.get(i));
            }
            res.put("focus", focus);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Places search error:", err);
            ObjectNode res = Json.obj();
            res.putArray("places");
            return ResponseEntity.ok(res);
        }
    }

    /** {@code mapPlace()} from the TS route — optional fields omitted, never null. */
    private static ObjectNode mapPlace(JsonNode p) {
        String name = Js.str(p.get("title"), 120);
        if (name == null) {
            return null;
        }
        JsonNode gps = p.get("gps_coordinates");
        Double lat = Js.finite(gps == null ? null : gps.get("latitude"));
        Double lng = Js.finite(gps == null ? null : gps.get("longitude"));
        String thumb = Js.str(p.get("thumbnail"), 600);

        ObjectNode o = Json.obj();
        o.put("name", name);
        putNumIfPresent(o, "rating", Js.finite(p.get("rating")));
        putNumIfPresent(o, "reviews", Js.finite(p.get("reviews")));
        putStrIfPresent(o, "type", Js.str(p.get("type"), 60));
        putStrIfPresent(o, "address", Js.str(p.get("address"), 160));
        JsonNode hours = p.get("open_state");
        if (hours == null || hours.isNull()) {
            hours = p.get("hours");
        }
        putStrIfPresent(o, "openState", Js.str(hours, 80));
        putStrIfPresent(o, "description", Js.str(p.get("description"), 200));
        putStrIfPresent(o, "price", Js.str(p.get("price"), 40));
        if (thumb != null && HTTP_URL.matcher(thumb).find()) {
            o.put("thumbnail", thumb);
        }
        if (lat != null) {
            Js.putNum(o, "lat", lat);
        }
        if (lng != null) {
            Js.putNum(o, "lng", lng);
        }
        return o;
    }

    // ----------------------------------------------------- /api/agent/stays

    @PostMapping("/stays")
    public ResponseEntity<?> stays(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = requireObjectBody(raw);

            String destination = stringOr(body, "destination", "").trim();
            if (destination.isEmpty()) {
                return ResponseEntity.badRequest().body(error("destination required"));
            }

            String kind = stayKind(stringOr(body, "accommodationType", ""));
            String currency = currencyTool.detectLocalCurrency(destination);
            String checkIn = futureIso(body.get("startDate"), 14);
            String checkOut = futureIso(body.get("endDate"), 17);
            double adultsRaw = Js.num(body.get("numAdults"));
            double adults = Double.isFinite(adultsRaw) ? Math.min(Math.max(adultsRaw, 1), 9) : 1;

            Map<String, Object> params = new LinkedHashMap<>();
            params.put("engine", "google_hotels");
            params.put("q", kind + " in " + destination);
            params.put("check_in_date", checkIn);
            params.put("check_out_date", checkOut);
            params.put("adults", Js.numStr(adults));
            params.put("currency", currency);
            params.put("gl", "us");
            params.put("hl", "en");
            JsonNode data = serp.search(params);

            List<JsonNode> props = new ArrayList<>();
            for (JsonNode p : Json.elements(Json.arrOr(data, "properties"))) {
                props.add(p);
            }

            Map<String, Double> usdRates = Map.of();
            if (!props.isEmpty()) {
                try {
                    usdRates = currencyTool.getExchangeRates("USD");
                } catch (Exception e) {
                    usdRates = Map.of();
                }
            }
            Double perUsd = usdRates.get(currency);

            List<StayCard> stays = new ArrayList<>();
            for (JsonNode p : props) {
                JsonNode nameNode = p.get("name");
                JsonNode rate = p.get("rate_per_night");
                JsonNode extracted = rate == null ? null : rate.get("extracted_lowest");
                if (!Js.truthy(nameNode) || extracted == null || extracted.isNull()) {
                    continue;
                }
                double priceValue = Js.num(extracted);
                // `perUsd && perUsd > 0` guards both undefined and degenerate rates.
                Double priceUsd = (perUsd != null && perUsd > 0)
                        ? Js.jsRound((priceValue / perUsd) * 10) / 10
                        : null;

                JsonNode images = p.get("images");
                JsonNode img = images != null && images.isArray() && images.size() > 0 ? images.get(0) : null;
                String thumb = trimmed(img == null ? null : img.get("thumbnail"));
                String original = trimmed(img == null ? null : img.get("original_image"));
                String image = thumb != null && HTTP_URL.matcher(thumb).find()
                        ? thumb
                        : original != null && HTTP_URL.matcher(original).find() ? original : null;

                ObjectNode stay = Json.obj();
                stay.put("name", Js.jsString(nameNode));
                JsonNode ratingNode = p.get("overall_rating");
                if (ratingNode != null && ratingNode.isNumber()) {
                    Js.putNum(stay, "rating", Js.jsRound(ratingNode.asDouble() * 10) / 10);
                }
                JsonNode reviewsNode = p.get("reviews");
                if (reviewsNode != null && reviewsNode.isNumber()) {
                    Js.putNum(stay, "reviews", reviewsNode.asDouble());
                }
                JsonNode lowest = rate == null ? null : rate.get("lowest");
                if (Js.truthy(lowest)) {
                    stay.put("price", Js.jsString(lowest));
                } else {
                    stay.put("price", currency + " " + Js.numStr(priceValue));
                }
                Js.putNum(stay, "priceValue", priceValue);
                stay.put("currency", currency);
                if (priceUsd != null) {
                    Js.putNum(stay, "priceUsd", priceUsd);
                }
                if (image != null) {
                    stay.put("image", image);
                }
                stay.put("kind", kind);
                ArrayNode amenities = stay.putArray("amenities");
                JsonNode amenityList = p.get("amenities");
                if (amenityList != null && amenityList.isArray()) {
                    int added = 0;
                    for (JsonNode a : amenityList) {
                        if (added >= 4) {
                            break;
                        }
                        amenities.add(Js.jsString(a));
                        added++;
                    }
                }
                JsonNode gps = p.get("gps_coordinates");
                Js.putRaw(stay, "lat", gps == null ? null : gps.get("latitude"));
                Js.putRaw(stay, "lng", gps == null ? null : gps.get("longitude"));
                JsonNode linkNode = p.get("link");
                if (linkNode != null && linkNode.isTextual()
                        && HTTP_URL.matcher(linkNode.asText()).find()) {
                    stay.put("link", linkNode.asText());
                }

                stays.add(new StayCard(stay, priceUsd, extracted.isNumber() ? priceValue : null));
                if (stays.size() >= 20) {
                    break;
                }
            }

            // Free fallback (OpenStreetMap) when SerpAPI is missing, throttled, or empty.
            if (stays.isEmpty()) {
                Coord center = osm.geocodeCenter(destination);
                if (center != null) {
                    for (OsmPoint p : osm.overpassNearby(center.lat(), center.lng(), kind, 10, 20)) {
                        ObjectNode stay = Json.obj();
                        stay.put("name", p.name());
                        stay.put("kind", kind);
                        ArrayNode amenities = stay.putArray("amenities");
                        if (p.openingHours() != null) {
                            amenities.add("Hours: " + p.openingHours());
                        }
                        stay.put("currency", currency);
                        Js.putNum(stay, "lat", p.lat());
                        Js.putNum(stay, "lng", p.lng());
                        stays.add(new StayCard(stay, null, null));
                    }
                }
            }

            // Budget: nightly cap from the form (fallback ≈ 40% of daily trip budget).
            double budgetRaw = Js.num(body.get("accommodationBudget"));
            double totalBudget = Js.num(body.get("totalBudget"));
            double numDays = orDefault(Js.num(body.get("numDays")), 3);
            double nightly;
            if (budgetRaw > 0) {
                nightly = budgetRaw;
            } else if (totalBudget > 0) {
                nightly = Math.max(20, Js.jsRound((totalBudget / numDays) * 0.4));
            } else {
                nightly = 0;
            }

            // Form budgets are in USD; compare stay prices in USD (convert via perUsd when needed).
            for (StayCard s : stays) {
                if (nightly <= 0) {
                    s.json().put("withinBudget", true);
                } else if (s.priceUsd() != null) {
                    s.json().put("withinBudget", s.priceUsd() <= nightly);
                } else if (perUsd != null && perUsd > 0 && s.priceValue() != null) {
                    s.json().put("withinBudget", s.priceValue() / perUsd <= nightly);
                }
                // omitted = conversion unavailable → chip hidden in the UI
            }

            List<StayCard> within = new ArrayList<>();
            List<StayCard> over = new ArrayList<>();
            for (StayCard s : stays) {
                JsonNode flag = s.json().get("withinBudget");
                if (flag == null || flag.asBoolean(false) != false) {
                    within.add(s); // `withinBudget !== false`
                } else {
                    over.add(s);
                }
            }
            within.sort(Comparator.comparingDouble((StayCard s) -> ratingOf(s.json())).reversed());
            over.sort(Comparator.comparingDouble(
                    s -> s.priceValue() == null ? Double.POSITIVE_INFINITY : s.priceValue()));
            List<StayCard> ordered = new ArrayList<>(within);
            ordered.addAll(over);
            if (ordered.size() > 8) {
                ordered = new ArrayList<>(ordered.subList(0, 8));
            }

            ObjectNode res = Json.obj();
            ArrayNode arr = res.putArray("stays");
            for (StayCard s : ordered) {
                arr.add(s.json());
            }
            res.put("currency", currency);
            Js.putNum(res, "nightlyBudget", nightly);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Stays search error:", err);
            ObjectNode res = Json.obj();
            res.putArray("stays");
            return ResponseEntity.ok(res);
        }
    }

    /** JSON to serialise plus the two fields the budget pass may still read. */
    private record StayCard(ObjectNode json, Double priceUsd, Double priceValue) {
    }

    /** TS {@code stayKind()} — the accommodation phrasing SerpAPI/OSM both search. */
    private static String stayKind(String accommodationType) {
        String t = accommodationType.toLowerCase(Locale.ROOT);
        if (t.contains("camping")) {
            return "camping sites";
        }
        if (t.contains("rental") || t.contains("airbnb")) {
            return "vacation rentals";
        }
        if (t.contains("guesthouse") || t.contains("b&b")) {
            return "guesthouses";
        }
        if (t.contains("hostel")) {
            return "hostels";
        }
        if (t.contains("resort")) {
            return "resorts";
        }
        if (t.contains("5-star") || t.contains("luxury")) {
            return "luxury hotels";
        }
        if (t.contains("4-star")) {
            return "4 star hotels";
        }
        if (t.contains("3-star")) {
            return "3 star hotels";
        }
        return "hotels";
    }

    /**
     * TS {@code futureIso()} — a future-looking ISO date passes through, anything
     * else becomes "in {@code fallbackDays} days". {@code new Date(raw + "T00:00:00")}
     * parses in the server's local zone, hence {@link ZoneId#systemDefault()}.
     */
    private static String futureIso(JsonNode raw, int fallbackDays) {
        if (raw != null && raw.isTextual()) {
            String value = raw.asText();
            if (ISO_DATE.matcher(value).matches()) {
                try {
                    long millis = LocalDateTime.parse(value + "T00:00:00")
                            .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
                    if (millis > System.currentTimeMillis() - 86_400_000L) {
                        return value;
                    }
                } catch (DateTimeParseException ignored) {
                    // Invalid calendar date ("2026-13-45") → JS `new Date()` is NaN too.
                }
            }
        }
        return Instant.now().plusSeconds(fallbackDays * 86_400L)
                .atZone(ZoneOffset.UTC).toLocalDate().format(ISO);
    }

    // -------------------------------------------------------------- helpers

    /**
     * {@code await req.json()} semantics shared by the two sub-routes: invalid
     * or empty body behaves like the TS promise rejecting, and a parsed
     * {@code null} body throws when the route destructures it.
     */
    private static JsonNode requireObjectBody(String raw) {
        JsonNode body = Json.parseOrNull(raw);
        if (body == null || body.isMissingNode()) {
            throw new IllegalArgumentException("Request body is not valid JSON");
        }
        if (body.isNull()) {
            throw new IllegalArgumentException("Cannot destructure property of null");
        }
        return body;
    }

    /** TS {@code String(x ?? fallback)}. */
    private static String stringOr(JsonNode body, String field, String fallback) {
        JsonNode v = body == null ? null : body.get(field);
        if (v == null || v.isNull()) {
            return fallback;
        }
        return Js.jsString(v);
    }

    /** TS {@code typeof v === "number" ? clamp(v, lo, hi) : fallback}. */
    private static int intLimit(JsonNode body, String field, int fallback, int lo, int hi) {
        JsonNode v = body == null ? null : body.get(field);
        if (v == null || !v.isNumber()) {
            return fallback;
        }
        return (int) Math.min(Math.max(v.asDouble(), lo), hi);
    }

    /** TS {@code Number(x) || fallback} (only {@code NaN}/{@code 0} fall through). */
    private static double orDefault(double value, double fallback) {
        return (Double.isNaN(value) || value == 0) ? fallback : value;
    }

    /** Trimmed, never truncated — for the stay image/link probes. */
    private static String trimmed(JsonNode v) {
        if (v == null || !v.isTextual()) {
            return null;
        }
        String s = v.asText().trim();
        return s.isEmpty() ? null : s;
    }

    private static double ratingOf(ObjectNode stay) {
        JsonNode rating = stay.get("rating");
        return rating != null && rating.isNumber() ? rating.asDouble() : 0;
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }

    private static void putNumIfPresent(ObjectNode node, String field, Double value) {
        if (value != null) {
            Js.putNum(node, field, value);
        }
    }

    private static void putStrIfPresent(ObjectNode node, String field, String value) {
        if (value != null) {
            node.put(field, value);
        }
    }
}
