package com.tripcraft.backend.flights;

import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/flightOffers.ts} — the wire shape of a flight offer.
 *
 * <p>Optional TS fields ({@code price?}, {@code currency?}, {@code bookingUrl?},
 * {@code durationMin?}) become nullable Java fields whose JSON key is simply
 * left out when {@code null}, exactly as {@code JSON.stringify} drops
 * {@code undefined}. Everything the TS always emits (e.g. {@code stops},
 * {@code travelClass}, the empty-string placeholders) stays present.
 *
 * <p>The static field readers below reproduce the {@code a.b || ""} /
 * {@code typeof a.b === "number"} idioms the TypeScript routes use inline.
 */
public final class FlightOffers {

    private FlightOffers() {
    }

    // ------------------------------------------------- TS field readers

    /**
     * A scalar field as text: {@code null} when absent or JSON {@code null}
     * (the JS {@code undefined}/{@code null} distinction the {@code ??} and
     * {@code ||} chains key off). Numbers and booleans stringify like
     * {@code String(value)}.
     */
    public static String text(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) {
            return null;
        }
        if (v.isTextual() || v.isNumber() || v.isBoolean()) {
            return v.asText();
        }
        return null;
    }

    /** TS truthiness for strings: {@code null}/empty → {@code null} ({@code || undefined}). */
    public static String truthy(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    public static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** TS {@code typeof x === "number" ? x : undefined}. */
    public static Double numberOrNull(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode v = node.get(field);
        return v != null && v.isNumber() ? v.asDouble() : null;
    }

    /** JS truthiness of a whole JSON value ({@code undefined}/{@code null}/0/""/false are falsy). */
    public static boolean jsTruthy(JsonNode value) {
        if (value == null || value.isNull() || value.isMissingNode()) {
            return false;
        }
        if (value.isBoolean()) {
            return value.asBoolean();
        }
        if (value.isTextual()) {
            return !value.asText().isEmpty();
        }
        if (value.isNumber()) {
            return value.asDouble() != 0;
        }
        return true;
    }

    /**
     * Whole numbers serialise without a {@code .0} suffix so the bytes match
     * {@code JSON.stringify} (JS has a single Number type).
     */
    public static void putNum(ObjectNode node, String field, double value) {
        if (value == Math.floor(value) && !Double.isInfinite(value) && Math.abs(value) <= 9.0e15) {
            node.put(field, (long) value);
        } else {
            node.put(field, value);
        }
    }

    // ------------------------------------------------- wire shape

    /** Port of the {@code FlightLeg} interface. */
    public record FlightLeg(String from, String to, String depart, String arrive,
                            String airline, String logo, String flightNumber,
                            Double durationMin) {

        private ObjectNode toJson() {
            ObjectNode node = Json.obj();
            node.put("from", from);
            node.put("to", to);
            node.put("depart", depart);
            node.put("arrive", arrive);
            node.put("airline", airline);
            node.put("logo", logo);
            node.put("flightNumber", flightNumber);
            if (durationMin != null) {
                putNum(node, "durationMin", durationMin);
            }
            return node;
        }
    }

    /** Port of the {@code FlightOffer} interface. */
    public record FlightOffer(String kind, Double price, String currency, String bookingUrl,
                              Double durationMin, double stops, String airline, String airlineLogo,
                              String travelClass, String departAt, String arriveAt,
                              String from, String to, String fromName, String toName,
                              List<FlightLeg> legs) {

        public ObjectNode toJson() {
            ObjectNode node = Json.obj();
            node.put("kind", kind);
            if (price != null) {
                putNum(node, "price", price);
            }
            Json.putIfPresent(node, "currency", currency);
            Json.putIfPresent(node, "bookingUrl", bookingUrl);
            if (durationMin != null) {
                putNum(node, "durationMin", durationMin);
            }
            putNum(node, "stops", stops);
            node.put("airline", airline);
            node.put("airlineLogo", airlineLogo);
            node.put("travelClass", travelClass);
            node.put("departAt", departAt);
            node.put("arriveAt", arriveAt);
            node.put("from", from);
            node.put("to", to);
            node.put("fromName", fromName);
            node.put("toName", toName);
            ArrayNode list = node.putArray("legs");
            for (FlightLeg leg : legs) {
                list.add(leg.toJson());
            }
            return node;
        }
    }
}
