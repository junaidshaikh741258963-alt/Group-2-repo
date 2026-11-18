package com.tripcraft.backend.api;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

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
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Coord;
import com.tripcraft.backend.places.Js;
import com.tripcraft.backend.places.OsmPoint;
import com.tripcraft.backend.places.OsmService;
import com.tripcraft.backend.places.RouteStops;

/**
 * Port of {@code src/app/api/route-places/route.ts} — everything worth
 * stopping for <em>between</em> an origin and a destination.
 *
 * <p>The client posts the route polyline (OSRM GeoJSON {@code [lng, lat]}
 * pairs); we spread a handful of anchors along it, ask Overpass for every
 * category in one unioned request, then project each hit onto the polyline so
 * the response carries both "how far off the road" and "when you'd reach it".
 */
@RestController
@RequestMapping("/api/route-places")
public class RoutePlacesController {

    private static final Logger log = LoggerFactory.getLogger(RoutePlacesController.class);

    /** Categories to look for along the road — unioned into one Overpass query. */
    private static final List<String> CORRIDOR_QUERIES = List.of(
            "hotel",
            "restaurants",
            "cafes",
            "tourist attractions",
            "landmark monuments",
            "shopping");

    /** One anchor per this many km of road (bounds query size on long routes). */
    private static final double ANCHOR_SPACING_KM = 120;
    private static final int MIN_ANCHORS = 3;
    /** Matches {@code overpassAlongAnchors}' own cap — beyond this the union query
     *  stops finishing inside the public instances' timeout. */
    private static final int MAX_ANCHORS = 6;
    /** GeoJSON is denser than we need — projections stay accurate well below this. */
    private static final int MAX_PATH_POINTS = 2000;
    private static final int MAX_PATH_COORDS = 6000;

    private static final int OVERPASS_TIMEOUT_MS = 25_000;
    private static final int OVERPASS_DEADLINE_MS = 32_000;

    /** Nominatim asks for ≤1 request/second, hence the spacing between looks. */
    private static final long NOMINATIM_SPACING_MS = 1100;

    private final OsmService osm;

    public RoutePlacesController(OsmService osm) {
        this.osm = osm;
    }

    @PostMapping
    public ResponseEntity<?> routePlaces(@RequestBody(required = false) String raw) {
        try {
            // TS: `await req.json().catch(() => (null))`.
            JsonNode body = Json.parseOrNull(raw);

            List<double[]> path = new ArrayList<>();
            JsonNode rawPath = body == null || !body.isObject() ? null : body.get("path");
            if (rawPath != null && rawPath.isArray()) {
                for (JsonNode pair : rawPath) {
                    if (pair == null || !pair.isArray() || pair.size() < 2) {
                        continue;
                    }
                    double lng = jsNumber(pair.get(0));
                    double lat = jsNumber(pair.get(1));
                    if (!Double.isFinite(lat) || !Double.isFinite(lng)
                            || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                        continue;
                    }
                    path.add(new double[] { lng, lat });
                    if (path.size() >= MAX_PATH_COORDS) {
                        break;
                    }
                }
            }
            if (path.size() < 2) {
                return ResponseEntity.badRequest().body(error("path with 2+ coordinates required"));
            }

            double corridorKm = clamp(orDefault(jsNumber(body.get("corridorKm")), 10), 1, 30);
            double limit = clamp(orDefault(jsNumber(body.get("limit")), 80), 1, 120);

            List<double[]> shape = thinPath(path, MAX_PATH_POINTS);
            List<Double> cum = cumulativeKm(shape);
            double totalKm = cum.get(cum.size() - 1);
            List<Coord> points = anchors(shape, cum, totalKm, MAX_ANCHORS);

            List<OsmPoint> hits = osm.overpassAlongAnchors(points, corridorKm, CORRIDOR_QUERIES,
                    (int) (limit * 3), OVERPASS_TIMEOUT_MS, OVERPASS_DEADLINE_MS);

            // Mirrors down → a few quiet Nominatim looks spread along the road so
            // the panel still shows something (one category per point).
            if (hits.isEmpty()) {
                hits = nominatimCorridorFallback(shape, limit);
            }

            Set<String> seen = new HashSet<>();
            List<ObjectNode> places = new ArrayList<>();
            for (OsmPoint p : hits) {
                String key = p.name().trim().toLowerCase(Locale.ROOT) + "|"
                        + toFixed(p.lat(), 4) + "," + toFixed(p.lng(), 4);
                if (!seen.add(key)) {
                    continue;
                }
                Projection projection = project(shape, cum, p.lng(), p.lat());
                if (projection.offKm() > corridorKm) {
                    continue;
                }
                ObjectNode place = Json.obj();
                place.put("id", "stop-" + places.size());
                place.put("name", p.name());
                Js.putNum(place, "lat", p.lat());
                Js.putNum(place, "lng", p.lng());
                place.put("kind", RouteStops.normalizeStopKind(p.category()));
                Json.putIfPresent(place, "category", p.category());
                Json.putIfPresent(place, "address", p.address());
                Js.putNum(place, "offRouteKm", round1(projection.offKm()));
                Js.putNum(place, "alongKm", round1(projection.alongKm()));
                Json.putIfPresent(place, "openingHours", p.openingHours());
                Json.putIfPresent(place, "website", p.website());
                Json.putIfPresent(place, "phone", p.phone());
                places.add(place);
                if (places.size() >= limit) {
                    break;
                }
            }

            // Route order: what you reach first comes first.
            places.sort(java.util.Comparator.comparingDouble(place -> place.path("alongKm").asDouble(0)));

            ObjectNode res = Json.obj();
            ArrayNode arr = res.putArray("places");
            for (ObjectNode place : places) {
                arr.add(place);
            }
            Js.putNum(res, "totalKm", round1(totalKm));
            Js.putNum(res, "corridorKm", corridorKm);
            res.put("anchors", points.size());
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("Route places error:", err);
            ObjectNode res = Json.obj();
            res.putArray("places");
            return ResponseEntity.ok(res);
        }
    }

    /**
     * Last resort when every Overpass mirror is down: three category searches
     * spread along the road, a second apart to respect Nominatim's rate limit.
     */
    private List<OsmPoint> nominatimCorridorFallback(List<double[]> shape, double limit) {
        List<double[]> pts = corridorSamples(shape);
        List<String> queries = List.of("restaurants", "tourist attractions", "hotels");
        int perPoint = (int) Math.max(4, Math.ceil(limit / Math.max(pts.size(), 1)));
        List<OsmPoint> out = new ArrayList<>();
        for (int i = 0; i < pts.size(); i++) {
            double[] pt = pts.get(i);
            String q = i < queries.size() ? queries.get(i) : null;
            if (pt == null || q == null) {
                continue;
            }
            if (i > 0) {
                OsmService.delay(NOMINATIM_SPACING_MS);
            }
            out.addAll(osm.nominatimInViewbox(q, pt[1], pt[0], 25, perPoint));
        }
        return out;
    }

    // ------------------------------------------------------------- geometry

    /** Keeps the polyline's shape while capping how many vertices we scan. */
    private static List<double[]> thinPath(List<double[]> pts, int max) {
        if (pts.size() <= max) {
            return pts;
        }
        int stride = (int) Math.ceil((double) pts.size() / max);
        List<double[]> out = new ArrayList<>();
        for (int i = 0; i < pts.size(); i += stride) {
            out.add(pts.get(i));
        }
        double[] last = pts.get(pts.size() - 1);
        if (last != null && (out.isEmpty() || out.get(out.size() - 1) != last)) {
            out.add(last);
        }
        return out;
    }

    /** Cumulative distance to each vertex, in km. */
    private static List<Double> cumulativeKm(List<double[]> path) {
        List<Double> cum = new ArrayList<>(path.size());
        for (int i = 0; i < path.size(); i++) {
            if (i == 0) {
                cum.add(0.0);
                continue;
            }
            double[] prev = path.get(i - 1);
            double[] cur = path.get(i);
            cum.add(cum.get(i - 1) + OsmService.haversineKm(prev[1], prev[0], cur[1], cur[0]));
        }
        return cum;
    }

    /** Nearest point on the polyline → how far off it is and when you pass it. */
    private static Projection project(List<double[]> path, List<Double> cum, double lng, double lat) {
        double offKm = Double.POSITIVE_INFINITY;
        double alongKm = 0;
        for (int i = 0; i < path.size(); i++) {
            double[] vertex = path.get(i);
            double d = OsmService.haversineKm(vertex[1], vertex[0], lat, lng);
            if (d < offKm) {
                offKm = d;
                alongKm = cum.get(i);
            }
        }
        return new Projection(offKm, alongKm);
    }

    private record Projection(double offKm, double alongKm) {
    }

    /** Points spread evenly along the road, at most {@code max} of them. */
    private static List<Coord> anchors(List<double[]> path, List<Double> cum, double totalKm, int max) {
        int count = (int) clamp(Math.ceil(totalKm / ANCHOR_SPACING_KM), MIN_ANCHORS, Math.min(max, MAX_ANCHORS));
        List<Coord> out = new ArrayList<>();
        for (int i = 1; i <= count; i++) {
            double target = (totalKm * i) / (count + 1);
            int idx = 0;
            while (idx < cum.size() - 1 && cum.get(idx + 1) < target) {
                idx++;
            }
            double[] pt = path.get(idx);
            if (pt != null) {
                out.add(new Coord(pt[1], pt[0]));
            }
        }
        return out;
    }

    /** Points at 25/50/75% along the road — where a driver would actually stop. */
    private static List<double[]> corridorSamples(List<double[]> shape) {
        if (shape.isEmpty()) {
            return List.of();
        }
        double[] t = { 0.25, 0.5, 0.75 };
        List<double[]> out = new ArrayList<>(t.length);
        for (double ratio : t) {
            out.add(shape.get(Math.min(shape.size() - 1, (int) Math.floor(shape.size() * ratio))));
        }
        return out;
    }

    // -------------------------------------------------------------- helpers

    /**
     * JS {@code Number(value)} for a pair element: {@code null} → 0, a
     * one-element array unwraps, objects and multi-element arrays → NaN.
     */
    private static double jsNumber(JsonNode v) {
        if (v != null && v.isArray()) {
            if (v.size() == 0) {
                return 0;
            }
            if (v.size() == 1) {
                return jsNumber(v.get(0));
            }
            return Double.NaN;
        }
        return Js.num(v);
    }

    /** TS {@code Math.round(x * 10) / 10}. */
    private static double round1(double v) {
        return Js.jsRound(v * 10) / 10;
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.min(Math.max(v, lo), hi);
    }

    /** TS {@code Number(x) || fallback} (only {@code NaN}/{@code 0} fall through). */
    private static double orDefault(double value, double fallback) {
        return (Double.isNaN(value) || value == 0) ? fallback : value;
    }

    /** {@code Number.prototype.toFixed()} — shortest decimal, half away from zero. */
    static String toFixed(double v, int digits) {
        return java.math.BigDecimal.valueOf(v)
                .setScale(digits, java.math.RoundingMode.HALF_UP)
                .toPlainString();
    }

    private static ObjectNode error(String message) {
        ObjectNode res = Json.obj();
        res.put("error", message);
        return res;
    }
}
