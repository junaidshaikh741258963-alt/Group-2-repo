package com.tripcraft.backend.flights;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.flights.FlightOffers.FlightLeg;
import com.tripcraft.backend.flights.FlightOffers.FlightOffer;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

import static com.tripcraft.backend.flights.FlightOffers.numberOrNull;
import static com.tripcraft.backend.flights.FlightOffers.orEmpty;
import static com.tripcraft.backend.flights.FlightOffers.text;
import static com.tripcraft.backend.flights.FlightOffers.truthy;

/**
 * Port of {@code src/lib/octotrip.ts} — OctoTrip's public flight-search MCP
 * endpoint. Free, no account and no API key, worldwide coverage — used as the
 * fallback when the paid search provider is rate-limited. Results are
 * affiliate-linked by them.
 */
public final class OctoTrip {

    private static final Logger log = LoggerFactory.getLogger(OctoTrip.class);

    private static final String MCP_URL = "https://mcp.octotrip.app/flights/mcp";
    private static final int TIMEOUT_MS = 45000;

    private OctoTrip() {
    }

    /**
     * JSON-RPC {@code tools/call} against the MCP endpoint. Returns the raw
     * {@code results} array, {@code []} when the payload has none, or
     * {@code null} for every failure (non-2xx, bad envelope, network) so the
     * caller falls through exactly like the TS does.
     */
    public static List<JsonNode> search(String origin, String destination, String departureDate,
                                        String returnDate, double adults, String currency) {
        try {
            ObjectNode arguments = Json.obj();
            arguments.put("origin", origin);
            arguments.put("destination", destination);
            arguments.put("departure_date", departureDate);
            if (returnDate != null && !returnDate.isEmpty()) {
                arguments.put("return_date", returnDate);
            }
            if (adults == Math.floor(adults) && !Double.isInfinite(adults)) {
                arguments.put("adults", (long) adults);
            } else {
                arguments.put("adults", adults);
            }
            arguments.put("currency", currency == null || currency.isEmpty() ? "USD" : currency);

            ObjectNode callParams = Json.obj();
            callParams.put("name", "search");
            callParams.set("arguments", arguments);

            ObjectNode rpc = Json.obj();
            rpc.put("jsonrpc", "2.0");
            rpc.put("id", 1);
            rpc.put("method", "tools/call");
            rpc.set("params", callParams);

            Http.Raw res = Http.post(MCP_URL, Json.write(rpc),
                    // The TS sends `Accept: application/json, text/event-stream`
                    // as ONE header line; infra.Http already emits `Accept: */*`,
                    // so re-declaring it here would put two Accept lines on the
                    // wire and OctoTrip answers 406. `*/*` alone gets the
                    // identical payload back.
                    Map.of(), TIMEOUT_MS);
            if (!res.ok()) {
                if (res.status() == 0) {
                    // fetch() rejection in the TS — logged before returning null.
                    log.warn("OctoTrip search failed: {}", res.body());
                }
                return null;
            }

            JsonNode envelope = parseMcpBody(res.body());
            String text = null;
            if (envelope != null) {
                JsonNode content = envelope.path("result").path("content");
                if (content.isArray() && content.size() > 0) {
                    JsonNode first = content.get(0).path("text");
                    if (first.isTextual()) {
                        text = first.asText();
                    }
                }
            }
            if (text == null || text.isEmpty()) {
                return null;
            }

            JsonNode parsed = Json.parseOrNull(text);
            if (parsed == null) {
                // TS: JSON.parse(text) threw, caught by the outer try/catch.
                log.warn("OctoTrip search failed: invalid JSON in tool result");
                return null;
            }
            JsonNode results = parsed.get("results");
            List<JsonNode> out = new ArrayList<>();
            if (results != null && results.isArray()) {
                results.forEach(out::add);
            }
            return out;
        } catch (Exception err) {
            log.warn("OctoTrip search failed: {}", err.getMessage() == null ? err : err.getMessage());
            return null;
        }
    }

    /**
     * SSE-ish MCP response → JSON-RPC envelope: first parseable {@code data:}
     * line wins, falling back to the body itself.
     */
    private static JsonNode parseMcpBody(String body) {
        if (body == null || body.isEmpty()) {
            return null;
        }
        for (String line : body.split("\r?\n")) {
            String trimmed = line.trim();
            if (!trimmed.startsWith("data:")) {
                continue;
            }
            JsonNode parsed = Json.parseOrNull(trimmed.substring(5).trim());
            if (parsed != null) {
                return parsed;
            }
            // keep scanning other data lines
        }
        return Json.parseOrNull(body);
    }

    /** Raw OctoTrip result → {@link FlightOffer}; {@code null} without an outbound set. */
    public static FlightOffer octoToOffer(JsonNode raw, String kind) {
        JsonNode out = raw == null ? null : raw.get("outbound");
        if (out == null || out.isNull()) {
            return null;
        }

        String departAt = stamp(out, "departure_date", "departure_time");
        String arriveAt = stamp(out, "arrival_date", "arrival_time");

        List<FlightLeg> legs = new ArrayList<>();
        JsonNode legList = out.get("legs");
        if (legList != null && legList.isArray()) {
            for (JsonNode leg : Json.elements(legList)) {
                String carrier = truthy(text(leg, "carrier"));
                String airline = carrier != null ? carrier : truthy(text(raw, "airline"));
                legs.add(new FlightLeg(
                        orEmpty(text(leg, "departure")),
                        orEmpty(text(leg, "arrival")),
                        stamp(leg, "departure_date", "departure_time"),
                        stamp(leg, "arrival_date", "arrival_time"),
                        orEmpty(airline),
                        "",
                        orEmpty(text(leg, "flight_number")),
                        numberOrNull(leg, "duration_minutes")));
            }
        }

        Double durationMin = numberOrNull(raw, "total_duration_minutes");
        if (durationMin == null) {
            durationMin = numberOrNull(out, "duration_minutes");
        }
        Double stops = numberOrNull(raw, "stops");
        if (stops == null) {
            stops = numberOrNull(out, "stops");
        }
        if (stops == null) {
            stops = (double) Math.max(legs.size() - 1, 0);
        }

        return new FlightOffer(
                kind,
                numberOrNull(raw, "price"),
                truthy(text(raw, "currency")),
                truthy(text(raw, "booking_url")),
                durationMin,
                stops,
                orEmpty(text(raw, "airline")),
                "",
                "Economy",
                departAt,
                arriveAt,
                orEmpty(text(out, "departure")),
                orEmpty(text(out, "arrival")),
                "",
                "",
                legs);
    }

    /** {@code [date, time].filter(Boolean).join(" ")}; {@code ""} when both are absent. */
    private static String stamp(JsonNode node, String dateField, String timeField) {
        String date = truthy(text(node, dateField));
        String time = truthy(text(node, timeField));
        if (date == null && time == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        if (date != null) {
            sb.append(date);
        }
        if (time != null) {
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(time);
        }
        return sb.toString();
    }
}
