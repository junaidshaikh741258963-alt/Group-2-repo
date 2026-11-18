package com.tripcraft.backend.api;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.hotels.Hotel;
import com.tripcraft.backend.hotels.Hotels;
import com.tripcraft.backend.hotels.JsCompat;
import com.tripcraft.backend.hotels.Recommendations;
import com.tripcraft.backend.hotels.Recommendations.RecType;
import com.tripcraft.backend.hotels.Recommendations.Recommendation;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Coord;
import com.tripcraft.backend.places.Js;
import com.tripcraft.backend.places.OsmPoint;
import com.tripcraft.backend.places.OsmService;

/**
 * Ports of {@code src/app/api/hotels/route.ts}, {@code hotels/photos} and
 * {@code hotels/reviews}.
 *
 * <p>Provider flow preserved: SerpAPI first (its shared key is out of monthly
 * quota in this environment, so {@code serp.search(...)} answers {@code null}
 * and the free OSM fallbacks are what actually run), then free
 * OpenStreetMap/Nominatim fallbacks, then an empty-but-valid
 * {@code {"hotels": []}}. Errors always degrade to the same empty response —
 * never a thrown 500 — exactly like the TypeScript.
 */
@RestController
@RequestMapping("/api/hotels")
public class HotelsController {

    private static final Logger log = LoggerFactory.getLogger(HotelsController.class);

    private static final Pattern SLUG_SEPARATOR = Pattern.compile("[^a-z0-9]+");
    private static final Pattern HTTP_I = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);
    private static final Pattern SERP_HOTEL_FILTER =
            Pattern.compile("hotel|hostel|motel|lodge|guest|resort|apartment", Pattern.CASE_INSENSITIVE);

    private final SerpApiService serp;
    private final Hotels hotels;
    private final OsmService osm;

    @Autowired
    public HotelsController(SerpApiService serp, Hotels hotels, OsmService osm) {
        this.serp = serp;
        this.hotels = hotels;
        this.osm = osm;
    }

    // ---------------------------------------------------------- /api/hotels

    @PostMapping
    public ResponseEntity<?> search(@RequestBody(required = false) String raw) {
        try {
            JsonNode parsed = Json.parseOrNull(raw);
            JsonNode body = parsed == null ? Json.obj() : parsed; // TS: req.json().catch(() => ({}))
            String q = JsCompat.jsTrim(text(body, "destination"));
            if (q.isEmpty()) {
                return ResponseEntity.badRequest().body(error("destination required"));
            }

            List<Recommendation> result = new ArrayList<>();

            // Live hotel search through the central SerpAPI manager (rotating keys,
            // null when no keys configured) with free OSM fallback below.
            String ci = checkDate(body.get("checkIn"), 14);
            String co = checkDate(body.get("checkOut"), 17);
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("engine", "google_hotels");
            params.put("q", "hotels in " + q);
            params.put("check_in_date", ci);
            params.put("check_out_date", co);
            params.put("adults", 2);
            params.put("currency", "USD");
            params.put("gl", "us");
            params.put("hl", "en");
            JsonNode data = serp.search(params);

            for (JsonNode p : Json.arrOr(data, "properties")) {
                JsonNode gps = p.get("gps_coordinates");
                JsonNode latNode = gps == null ? null : gps.get("latitude");
                JsonNode lngNode = gps == null ? null : gps.get("longitude");
                if (!Js.truthy(p.get("name")) || latNode == null || !latNode.isNumber()
                        || lngNode == null || !lngNode.isNumber()) {
                    continue;
                }
                double lat = latNode.asDouble();
                double lng = lngNode.asDouble();

                double ratingRaw = Js.num(p.get("overall_rating"));
                Double rating = p.path("overall_rating").isNumber() ? Math.round(ratingRaw * 10) / 10.0 : null;

                JsonNode lowest = p.path("rate_per_night").get("extracted_lowest");
                String price = lowest != null && lowest.isNumber()
                        ? "$" + Js.numStr(Math.round(lowest.asDouble())) + "/night"
                        : null;

                JsonNode gallery = p.get("images");
                JsonNode first = gallery != null && gallery.isArray() && !gallery.isEmpty() ? gallery.get(0) : null;
                String thumbnail = p.path("thumbnail").isTextual() && p.path("thumbnail").asText().startsWith("http")
                        ? p.path("thumbnail").asText()
                        : null;
                String galleryThumb = first != null && first.path("thumbnail").isTextual()
                        ? first.path("thumbnail").asText()
                        : null;
                String galleryOriginal = first != null && first.path("original_image").isTextual()
                        ? first.path("original_image").asText()
                        : null;
                String image = thumbnail != null ? thumbnail
                        : galleryThumb != null ? galleryThumb
                                : galleryOriginal;

                String type = Js.truthy(p.get("type"))
                        ? Js.jsString(p.get("type")).replace('_', ' ')
                        : "Hotel";

                result.add(new Recommendation(
                        "serp-" + result.size(),
                        Js.jsString(p.get("name")),
                        RecType.HOTEL,
                        lat,
                        lng,
                        null,
                        type,
                        rating,
                        null,
                        price,
                        null,
                        image,
                        textOrNull(p, "property_token"),
                        textOrNull(p, "link")));
                if (result.size() >= 12) {
                    break;
                }
            }

            // Free fallbacks (OpenStreetMap) when SerpAPI is missing, throttled, or empty.
            if (result.isEmpty()) {
                Coord center = osm.geocodeCenter(q);
                if (center != null) {
                    // TS: await Promise.race([searchHotels(...), delay(6000)])
                    CompletableFuture<List<Hotel>> future = CompletableFuture.supplyAsync(
                            () -> hotels.searchHotels(center.lat(), center.lng(), 8, 12));
                    List<Hotel> osmHotels;
                    try {
                        osmHotels = future.get(6, TimeUnit.SECONDS);
                    } catch (Exception e) {
                        osmHotels = null;
                    }
                    for (Hotel h : osmHotels == null ? List.<Hotel>of() : osmHotels) {
                        String description = h.address() != null && !"Nearby".equals(h.address())
                                ? h.address()
                                : h.stars() + "-star hotel";
                        result.add(new Recommendation(
                                "osm-" + Js.numStr(h.id()),
                                h.name(),
                                RecType.HOTEL,
                                h.lat(),
                                h.lng(),
                                null,
                                description,
                                h.stars() >= 2 ? (double) h.stars() : null,
                                null,
                                "$" + h.pricePerNight() + "/night",
                                null,
                                null,
                                null,
                                h.website()));
                    }
                }
            }

            // Last resort: free-text Nominatim POI search (works when Overpass is down).
            if (result.isEmpty()) {
                List<OsmPoint> pois = osm.nominatimPois("hotels in " + q, 12);
                int index = 0;
                for (OsmPoint p : pois) {
                    if (!SERP_HOTEL_FILTER.matcher(jsTemplate(p.category()) + " " + p.name()).find()) {
                        continue;
                    }
                    String slug = SLUG_SEPARATOR.matcher(JsCompat.jsLowerCase(p.name())).replaceAll("-");
                    result.add(new Recommendation(
                            "poi-" + index + "-" + JsCompat.slice(slug, 40),
                            p.name(),
                            RecType.HOTEL,
                            p.lat(),
                            p.lng(),
                            null,
                            p.address(),
                            null,
                            null,
                            null,
                            null,
                            null,
                            null,
                            null));
                    index++;
                }
            }

            ObjectNode res = Json.obj();
            ArrayNode hotelsOut = res.putArray("hotels");
            for (Recommendation r : result) {
                hotelsOut.add(r.wire());
            }
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Hotel search error:", err);
            return ResponseEntity.ok(empty("hotels"));
        }
    }

    // -------------------------------------------------- /api/hotels/photos

    @PostMapping("/photos")
    public ResponseEntity<?> photos(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = Json.parseOrNull(raw);
            if (body == null) {
                throw new IllegalArgumentException("Request body is not valid JSON");
            }
            String token = serp.resolvePropertyToken(textOrNull(body, "propertyToken"), textOrNull(body, "name"));
            if (token == null) {
                return ResponseEntity.ok(empty("photos"));
            }

            JsonNode data = serp.search(Map.of("engine", "google_hotels_photos", "property_token", token));

            ArrayNode photos = Json.arr();
            for (JsonNode section : Json.arrOr(data, "sections")) {
                String sectionTitle = JsCompat.slice(Js.truthy(section.get("title"))
                        ? Js.jsString(section.get("title"))
                        : "", 60);
                for (JsonNode p : Json.arrOr(section, "photos")) {
                    String url = firstTruthyText(p.get("photo_url"), p.get("thumbnail_url"));
                    String thumb = firstTruthyText(p.get("thumbnail_url"), p.get("photo_url"));
                    if (url == null || !HTTP_I.matcher(url).find()) {
                        continue;
                    }
                    ObjectNode photo = Json.obj();
                    photo.put("url", url);
                    photo.put("thumb", thumb != null && HTTP_I.matcher(thumb).find() ? thumb : url);
                    photo.put("section", sectionTitle);
                    if (p.path("source").isTextual()) {
                        photo.put("source", p.path("source").asText());
                    }
                    photos.add(photo);
                    if (photos.size() >= 24) {
                        break;
                    }
                }
                if (photos.size() >= 24) {
                    break;
                }
            }

            ObjectNode res = Json.obj();
            res.set("photos", photos);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Hotel photos error:", err);
            return ResponseEntity.ok(empty("photos"));
        }
    }

    // ------------------------------------------------- /api/hotels/reviews

    @PostMapping("/reviews")
    public ResponseEntity<?> reviews(@RequestBody(required = false) String raw) {
        try {
            JsonNode body = Json.parseOrNull(raw);
            if (body == null) {
                throw new IllegalArgumentException("Request body is not valid JSON");
            }
            String token = serp.resolvePropertyToken(textOrNull(body, "propertyToken"), textOrNull(body, "name"));
            if (token == null) {
                return ResponseEntity.ok(empty("reviews"));
            }

            JsonNode data = serp.search(Map.of("engine", "google_hotels_reviews", "property_token", token));

            ArrayNode reviews = Json.arr();
            for (JsonNode r : Json.arrOr(data, "reviews")) {
                ObjectNode item = Json.obj();
                boolean hasRating = r.path("rating").isNumber();
                if (hasRating) {
                    Js.putNum(item, "rating", r.path("rating").asDouble());
                }
                String snippet = r.path("snippet").isTextual() ? JsCompat.slice(r.path("snippet").asText(), 400) : "";
                String date = r.path("date").isTextual() ? JsCompat.slice(r.path("date").asText(), 40) : "";
                String source = r.path("source").isTextual() ? r.path("source").asText() : "";
                String link = r.path("link").isTextual() ? r.path("link").asText() : "";
                item.put("snippet", snippet);
                item.put("date", date);
                item.put("source", source);
                item.put("link", link);

                JsonNode user = r.get("user");
                String userName = user != null && user.path("name").isTextual() ? user.path("name").asText() : "";
                String userThumb = user != null && user.path("thumbnail").isTextual()
                        && HTTP_I.matcher(user.path("thumbnail").asText()).find()
                                ? user.path("thumbnail").asText()
                                : null;
                if (Js.truthy(user == null ? null : user.get("name"))
                        || Js.truthy(user == null ? null : user.get("thumbnail"))) {
                    ObjectNode userNode = item.putObject("user");
                    userNode.put("name", JsCompat.slice(userName, 40));
                    if (userThumb != null) {
                        userNode.put("thumbnail", userThumb);
                    }
                }

                if (!snippet.isEmpty() || hasRating) {
                    reviews.add(item);
                    if (reviews.size() >= 10) {
                        break;
                    }
                }
            }

            ObjectNode res = Json.obj();
            res.set("reviews", reviews);
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Hotel reviews error:", err);
            return ResponseEntity.ok(empty("reviews"));
        }
    }

    // ------------------------------------------------------------ helpers

    /** TS {@code checkIn ?? toIso(now + days)} — defaults land 14/17 days out (UTC). */
    private static String checkDate(JsonNode node, int days) {
        if (node != null && node.isTextual() && !node.asText().isEmpty()) {
            return node.asText();
        }
        return LocalDate.now(ZoneOffset.UTC).plusDays(days).toString();
    }

    /** JS {@code p.photo_url || p.thumbnail_url}: first node with JS-truthy value as text. */
    private static String firstTruthyText(JsonNode a, JsonNode b) {
        if (Js.truthy(a)) {
            return Js.jsString(a);
        }
        return Js.truthy(b) ? Js.jsString(b) : null;
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || v.isNull() ? "" : Js.jsString(v);
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    /** TS template literal {@code `${p.category} …`} spells undefined as "undefined". */
    private static String jsTemplate(String s) {
        return s == null ? "undefined" : s;
    }

    private static ObjectNode empty(String field) {
        ObjectNode res = Json.obj();
        res.set(field, Json.arr());
        return res;
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }
}
