package com.tripcraft.backend.agentlib;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Coord;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/lib/agent/routes.ts} — OSRM route lookups plus the
 * hand-rolled transport-mode suggestions used in the agent prompt.
 */
@Service
public class RoutesTool {

    private static final int OSRM_TIMEOUT_MS = 20000;

    public record RouteInfo(
            double distance,
            double duration,
            String distanceText,
            String durationText,
            List<double[]> geometry) {
    }

    public record TransportOption(
            String type,
            String description,
            String estimatedDuration,
            String estimatedCost,
            String notes) {
    }

    public RouteInfo getDrivingRoute(double originLat, double originLng, double destLat, double destLng) {
        try {
            String url = "https://router.project-osrm.org/route/v1/driving/" + Js.numStr(originLng) + ","
                    + Js.numStr(originLat) + ";" + Js.numStr(destLng) + "," + Js.numStr(destLat)
                    + "?overview=full&geometries=geojson";
            return parseRoute(url, true);
        } catch (Exception e) {
            return null;
        }
    }

    public RouteInfo getWalkingRoute(double originLat, double originLng, double destLat, double destLng) {
        try {
            String url = "https://router.project-osrm.org/route/v1/foot/" + Js.numStr(originLng) + ","
                    + Js.numStr(originLat) + ";" + Js.numStr(destLng) + "," + Js.numStr(destLat)
                    + "?overview=false";
            return parseRoute(url, false);
        } catch (Exception e) {
            return null;
        }
    }

    public RouteInfo getMultiStopRoute(List<Coord> stops) {
        if (stops.size() < 2) {
            return null;
        }
        StringBuilder coords = new StringBuilder();
        for (int i = 0; i < stops.size(); i++) {
            if (i > 0) {
                coords.append(';');
            }
            coords.append(Js.numStr(stops.get(i).lng())).append(',').append(Js.numStr(stops.get(i).lat()));
        }
        try {
            String url = "https://router.project-osrm.org/route/v1/driving/" + coords
                    + "?overview=full&geometries=geojson";
            return parseRoute(url, true);
        } catch (Exception e) {
            return null;
        }
    }
    private static RouteInfo parseRoute(String url, boolean withGeometry) {
        Http.Raw res = Http.get(url, Map.of(), OSRM_TIMEOUT_MS);
        if (!res.ok()) {
            return null;
        }
        JsonNode data = res.json();
        JsonNode routes = data == null ? null : data.get("routes");
        if (routes == null || !routes.isArray() || routes.isEmpty()) {
            return null;
        }
        JsonNode route = routes.get(0);
        double distance = route.path("distance").asDouble(0);
        double duration = route.path("duration").asDouble(0);
        List<double[]> geometry = null;
        if (withGeometry) {
            geometry = coordinates(route.path("geometry").path("coordinates"));
        }
        return new RouteInfo(
                distance,
                duration,
                formatDistance(distance),
                formatDuration(duration),
                geometry);
    }

    private static List<double[]> coordinates(JsonNode coords) {
        if (coords == null || !coords.isArray()) {
            return null;
        }
        List<double[]> out = new ArrayList<>();
        for (JsonNode pair : coords) {
            if (pair.isArray() && pair.size() >= 2) {
                out.add(new double[] { pair.get(0).asDouble(0), pair.get(1).asDouble(0) });
            }
        }
        return out;
    }

    public List<TransportOption> suggestTransportModes(double distanceKm) {
        List<TransportOption> options = new ArrayList<>();

        if (distanceKm <= 5) {
            options.add(new TransportOption(
                    "walking",
                    "Walk",
                    Js.numStr(Js.jsRound(distanceKm * 12)) + " min",
                    "Free",
                    "Great for short distances and sightseeing"));
            options.add(new TransportOption(
                    "taxi",
                    "Taxi / Ride-hail",
                    Js.numStr(Js.jsRound(distanceKm * 3)) + " min",
                    "$" + Js.numStr(Js.jsRound(3 + distanceKm * 1.5)) + "-"
                            + Js.numStr(Js.jsRound(5 + distanceKm * 2)),
                    "Convenient for door-to-door travel"));
        }

        if (distanceKm <= 30) {
            options.add(new TransportOption(
                    "public_transport",
                    "Public Transit (Bus/Metro)",
                    Js.numStr(Js.jsRound(distanceKm * 2.5)) + "-" + Js.numStr(Js.jsRound(distanceKm * 4)) + " min",
                    "$" + Js.numStr(Js.jsRound(1 + distanceKm * 0.1)) + "-"
                            + Js.numStr(Js.jsRound(2 + distanceKm * 0.15)),
                    "Most economical option"));
            options.add(new TransportOption(
                    "taxi",
                    "Taxi / Ride-hail",
                    Js.numStr(Js.jsRound(distanceKm * 2)) + "-" + Js.numStr(Js.jsRound(distanceKm * 3)) + " min",
                    "$" + Js.numStr(Js.jsRound(5 + distanceKm * 1.2)) + "-"
                            + Js.numStr(Js.jsRound(8 + distanceKm * 1.8)),
                    "Convenient, check local ride-hailing apps"));
        }

        if (distanceKm > 30) {
            options.add(new TransportOption(
                    "flight",
                    "Flight",
                    Js.numStr(Js.jsRound(distanceKm / 600 + 1.5)) + "h (including airport time)",
                    "$" + Js.numStr(Js.jsRound(50 + distanceKm * 0.08)) + "-"
                            + Js.numStr(Js.jsRound(100 + distanceKm * 0.15)),
                    "Search for flights on Google Flights or Skyscanner"));
            options.add(new TransportOption(
                    "train",
                    "Train",
                    Js.numStr(Js.jsRound(distanceKm / 80)) + "h",
                    "$" + Js.numStr(Js.jsRound(20 + distanceKm * 0.05)) + "-"
                            + Js.numStr(Js.jsRound(40 + distanceKm * 0.1)),
                    "Comfortable, scenic, book in advance for savings"));
            options.add(new TransportOption(
                    "bus",
                    "Bus",
                    Js.numStr(Js.jsRound(distanceKm / 60)) + "-" + Js.numStr(Js.jsRound(distanceKm / 50)) + "h",
                    "$" + Js.numStr(Js.jsRound(10 + distanceKm * 0.03)) + "-"
                            + Js.numStr(Js.jsRound(20 + distanceKm * 0.06)),
                    "Budget-friendly, longest travel time"));
        }

        return options;
    }

    public static String formatDistance(double meters) {
        if (meters < 1000) {
            return Js.numStr(Js.jsRound(meters)) + " m";
        }
        return String.format(java.util.Locale.ROOT, "%.1f", meters / 1000) + " km";
    }

    public static String formatDuration(double seconds) {
        long hours = (long) Math.floor(seconds / 3600);
        long minutes = (long) Math.floor((seconds % 3600) / 60);
        if (hours == 0) {
            return minutes + " min";
        }
        return hours + "h " + minutes + "min";
    }
}
