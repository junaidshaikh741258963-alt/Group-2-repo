package com.tripcraft.backend.api;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.db.Database;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/app/api/trips/route.ts} — saved-trip persistence over the
 * shared {@link Database}.
 *
 * <p>Wire compatibility notes:
 * <ul>
 *   <li>mysql2 hands the TS {@code Date} objects that {@code JSON.stringify}
 *       turns into ISO strings; the JDBC driver hands us
 *       {@code java.sql.Timestamp}, so {@link #toIso} formats them the same
 *       way ({@code yyyy-MM-dd'T'HH:mm:ss.SSS'Z'}).</li>
 *   <li>NULL columns become explicit JSON {@code null} (mysql2 keeps the key),
 *       which {@code ObjectNode} writes verbatim despite the global
 *       {@code non_null} inclusion.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/trips")
public class TripsController {

    private static final Logger log = LoggerFactory.getLogger(TripsController.class);

    private static final DateTimeFormatter ISO_UTC =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private static final String INSERT_SQL =
            "INSERT INTO trips (id, user_id, origin_name, destination_name, origin_lat, origin_lng, "
                    + "dest_lat, dest_lng, distance, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    private final Database database;

    @Autowired
    public TripsController(Database database) {
        this.database = database;
    }

    @GetMapping
    public ResponseEntity<?> getTrips(@RequestParam(required = false) String userId) {
        try {
            if (userId == null || userId.isEmpty()) {
                return ResponseEntity.ok(trips(Json.arr()));
            }

            List<Map<String, Object>> rows = database.query(
                    "SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC", userId);

            ArrayNode trips = Json.arr();
            for (Map<String, Object> row : rows) {
                trips.add(rowToJson(row));
            }
            return ResponseEntity.ok(trips(trips));
        } catch (Exception err) {
            log.error("Get trips error:", err);
            return ResponseEntity.ok(trips(Json.arr()));
        }
    }

    @PostMapping
    public ResponseEntity<?> saveTrip(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = Json.parseOrNull(raw);
            if (body == null || body.isNull()) {
                // TS: await req.json() rejects on an invalid body.
                throw new IllegalArgumentException("Request body is not valid JSON");
            }

            if (!Js.truthy(body.get("userId")) || !Js.truthy(body.get("origin_name"))
                    || !Js.truthy(body.get("destination_name"))) {
                return ResponseEntity.badRequest().body(error("Missing required fields"));
            }

            String tripId = UUID.randomUUID().toString();

            database.update(INSERT_SQL,
                    tripId, // TS passes the generated id FIRST
                    toJdbc(body.get("userId")),
                    toJdbc(body.get("origin_name")),
                    toJdbc(body.get("destination_name")),
                    toJdbc(body.get("origin_lat")),
                    toJdbc(body.get("origin_lng")),
                    toJdbc(body.get("dest_lat")),
                    toJdbc(body.get("dest_lng")),
                    jsOrZero(body.get("distance")), // distance || 0
                    jsOrZero(body.get("duration"))); // duration || 0

            ObjectNode res = Json.obj();
            res.put("message", "Trip saved");
            res.put("id", tripId);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Save trip error:", err);
            return ResponseEntity.status(500).body(error("Failed to save trip"));
        }
    }

    @DeleteMapping
    public ResponseEntity<?> deleteTrip(@RequestParam(required = false) String id) {
        try {
            if (id == null || id.isEmpty()) {
                return ResponseEntity.badRequest().body(error("Trip ID required"));
            }

            database.update("DELETE FROM trips WHERE id = ?", id);

            ObjectNode res = Json.obj();
            res.put("message", "Trip deleted");
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Delete trip error:", err);
            return ResponseEntity.status(500).body(error("Failed to delete trip"));
        }
    }

    // ------------------------------------------------------------ helpers

    private static ObjectNode trips(ArrayNode trips) {
        ObjectNode res = Json.obj();
        res.set("trips", trips);
        return res;
    }

    /** One {@code SELECT *} row → JSON the way mysql2 + JSON.stringify would emit it. */
    private static ObjectNode rowToJson(Map<String, Object> row) {
        ObjectNode node = Json.obj();
        for (Map.Entry<String, Object> entry : row.entrySet()) {
            Object v = entry.getValue();
            if (v == null) {
                node.putNull(entry.getKey()); // mysql2 keeps NULL keys; JSON.stringify keeps null
            } else if (v instanceof java.util.Date d) {
                node.put(entry.getKey(), toIso(d.toInstant()));
            } else if (v instanceof Number n) {
                Js.putNum(node, entry.getKey(), n.doubleValue()); // integral values without ".0"
            } else if (v instanceof Boolean b) {
                node.put(entry.getKey(), b);
            } else {
                node.put(entry.getKey(), String.valueOf(v));
            }
        }
        return node;
    }

    /** {@code Date.prototype.toISOString()} format, including the fixed ".000" millis. */
    private static String toIso(Instant instant) {
        return ISO_UTC.format(instant);
    }

    /** {@code x || 0}: truthy values pass through (parsed when textual), falsy ones become 0. */
    private static Object jsOrZero(JsonNode node) {
        if (!Js.truthy(node)) {
            return 0;
        }
        Object converted = toJdbc(node);
        return converted == null ? 0 : converted;
    }

    /** Raw body value → JDBC parameter (mysql2 passes JS values straight through). */
    private static Object toJdbc(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (node.isTextual()) {
            return node.asText();
        }
        if (node.isBoolean()) {
            return node.asBoolean();
        }
        if (node.isNumber()) {
            // Always bind as a double. canConvertToInt() only tests the int
            // RANGE, so 34.6937 "fits" and asInt() silently truncated every
            // latitude/longitude to whole degrees. JS numbers went to mysql2
            // as doubles.
            return node.asDouble();
        }
        return Js.jsString(node);
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }
}
