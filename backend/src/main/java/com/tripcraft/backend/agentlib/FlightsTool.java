package com.tripcraft.backend.agentlib;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/lib/agent/flights.ts} — deterministic flight suggestions
 * (durations/prices estimated from a built-in city distance table; the "API"
 * is a search query the model passes on to the user).
 */
@Service
public class FlightsTool {

    public record FlightSuggestion(
            String route,
            String type,
            String estimatedDuration,
            String estimatedPriceRange,
            String searchQuery,
            String tips) {
    }

    public List<FlightSuggestion> getFlightSuggestions(String origin, String destination, String departureDate,
            String returnDate, double travelers) {
        String originCity = origin.split(",")[0].trim();
        String destCity = destination.split(",")[0].trim();

        double distance = estimateFlightDistance(originCity, destCity);

        List<FlightSuggestion> suggestions = new ArrayList<>();

        // Direct flight suggestion
        suggestions.add(new FlightSuggestion(
                originCity + " → " + destCity,
                "Direct flight",
                estimateFlightDuration(distance, false),
                estimateFlightPrice(distance, "economy"),
                "flights from " + originCity + " to " + destCity + " on " + departureDate
                        + (returnDate != null && !returnDate.isEmpty() ? " returning " + returnDate : ""),
                "Book 2-3 weeks in advance for best prices. Use Google Flights or Skyscanner to compare."));

        // Budget option
        suggestions.add(new FlightSuggestion(
                originCity + " → " + destCity,
                "Budget / Connecting",
                estimateFlightDuration(distance, true),
                estimateFlightPrice(distance, "budget"),
                "cheap flights from " + originCity + " to " + destCity + " on " + departureDate,
                "Consider budget airlines (Ryanair, AirAsia, Spirit, IndiGo) or connecting flights for savings."));

        // Alternative airports
        suggestions.add(new FlightSuggestion(
                originCity + " → " + destCity + " area",
                "Nearby airports",
                estimateFlightDuration(distance, false),
                estimateFlightPrice(distance, "alternative"),
                "flights to " + destCity + " area airports on " + departureDate,
                "Check nearby airports - sometimes flying into a secondary airport saves significantly."));

        return suggestions;
    }

    private static double estimateFlightDistance(String origin, String destination) {
        Map<String, double[]> cities = cityTable();
        double[] o = cities.get(origin.toLowerCase(Locale.ROOT));
        double[] d = cities.get(destination.toLowerCase(Locale.ROOT));
        if (o != null && d != null) {
            return haversineDistance(o[0], o[1], d[0], d[1]);
        }
        // Default estimate
        return 5000;
    }

    private static Map<String, double[]> cityTable() {
        Map<String, double[]> cities = new HashMap<>();
        cities.put("new york", new double[] { 40.7, -74.0 });
        cities.put("london", new double[] { 51.5, -0.1 });
        cities.put("paris", new double[] { 48.9, 2.3 });
        cities.put("tokyo", new double[] { 35.7, 139.7 });
        cities.put("delhi", new double[] { 28.6, 77.2 });
        cities.put("mumbai", new double[] { 19.1, 72.9 });
        cities.put("dubai", new double[] { 25.2, 55.3 });
        cities.put("singapore", new double[] { 1.3, 103.8 });
        cities.put("bangkok", new double[] { 13.8, 100.5 });
        cities.put("bali", new double[] { -8.3, 115.2 });
        cities.put("rome", new double[] { 41.9, 12.5 });
        cities.put("berlin", new double[] { 52.5, 13.4 });
        cities.put("sydney", new double[] { -33.9, 151.2 });
        cities.put("los angeles", new double[] { 34.1, -118.2 });
        cities.put("san francisco", new double[] { 37.8, -122.4 });
        cities.put("chicago", new double[] { 41.9, -87.6 });
        cities.put("toronto", new double[] { 43.7, -79.4 });
        cities.put("miami", new double[] { 25.8, -80.2 });
        cities.put("amsterdam", new double[] { 52.4, 4.9 });
        cities.put("barcelona", new double[] { 41.4, 2.2 });
        cities.put("madrid", new double[] { 40.4, -3.7 });
        cities.put("istanbul", new double[] { 41.0, 28.9 });
        cities.put("cairo", new double[] { 30.0, 31.2 });
        cities.put("nairobi", new double[] { -1.3, 36.8 });
        cities.put("cape town", new double[] { -33.9, 18.4 });
        cities.put("rio de janeiro", new double[] { -22.9, -43.2 });
        cities.put("buenos aires", new double[] { -34.6, -58.4 });
        cities.put("mexico city", new double[] { 19.4, -99.1 });
        cities.put("seoul", new double[] { 37.6, 127.0 });
        cities.put("hong kong", new double[] { 22.3, 114.2 });
        cities.put("kuala lumpur", new double[] { 3.1, 101.7 });
        cities.put("hanoi", new double[] { 21.0, 105.8 });
        cities.put("phnom penh", new double[] { 11.6, 104.9 });
        cities.put("prague", new double[] { 50.1, 14.4 });
        cities.put("vienna", new double[] { 48.2, 16.4 });
        cities.put("budapest", new double[] { 47.5, 19.1 });
        cities.put("lisbon", new double[] { 38.7, -9.1 });
        cities.put("zurich", new double[] { 47.4, 8.5 });
        cities.put("stockholm", new double[] { 59.3, 18.1 });
        cities.put("oslo", new double[] { 59.9, 10.7 });
        cities.put("copenhagen", new double[] { 55.7, 12.6 });
        cities.put("helsinki", new double[] { 60.2, 24.9 });
        cities.put("athens", new double[] { 37.9, 23.7 });
        cities.put("jaipur", new double[] { 26.9, 75.8 });
        cities.put("goa", new double[] { 15.4, 73.8 });
        cities.put("kathmandu", new double[] { 27.7, 85.3 });
        cities.put("colombo", new double[] { 6.9, 79.9 });
        cities.put("malé", new double[] { 4.2, 73.5 });
        cities.put("taipei", new double[] { 25.0, 121.5 });
        cities.put("manila", new double[] { 14.6, 121.0 });
        cities.put("jakarta", new double[] { -6.2, 106.8 });
        cities.put("ho chi minh", new double[] { 10.8, 106.6 });
        cities.put("phuket", new double[] { 7.9, 98.3 });
        cities.put("chiang mai", new double[] { 18.8, 98.9 });
        cities.put("siem reap", new double[] { 13.4, 103.9 });
        cities.put("luang prabang", new double[] { 19.9, 102.1 });
        cities.put("yangon", new double[] { 16.9, 96.2 });
        cities.put("kolkata", new double[] { 22.6, 88.4 });
        cities.put("chennai", new double[] { 13.1, 80.3 });
        cities.put("bangalore", new double[] { 12.9, 77.6 });
        cities.put("hyderabad", new double[] { 17.4, 78.5 });
        cities.put("agra", new double[] { 27.2, 78.0 });
        cities.put("varanasi", new double[] { 25.3, 83.0 });
        cities.put("udaipur", new double[] { 24.6, 73.7 });
        cities.put("jodhpur", new double[] { 26.3, 73.0 });
        cities.put("pushkar", new double[] { 26.5, 74.6 });
        cities.put("manali", new double[] { 32.2, 77.2 });
        cities.put("shimla", new double[] { 31.1, 77.2 });
        cities.put("ladakh", new double[] { 34.2, 77.6 });
        cities.put("kashmir", new double[] { 34.1, 74.8 });
        return cities;
    }

    private static double haversineDistance(double lat1, double lon1, double lat2, double lon2) {
        double R = 6371;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static String estimateFlightDuration(double distanceKm, boolean connecting) {
        double hours = distanceKm / 600 + (connecting ? 2 : 1);
        return Js.numStr(Js.jsRound(hours)) + "h" + (connecting ? "+" : "");
    }

    private static String estimateFlightPrice(double distanceKm, String type) {
        double base = distanceKm * 0.08;
        switch (type) {
            case "budget":
                return "$" + Js.numStr(Js.jsRound(base * 0.5)) + "-$" + Js.numStr(Js.jsRound(base * 0.8));
            case "alternative":
                return "$" + Js.numStr(Js.jsRound(base * 0.7)) + "-$" + Js.numStr(Js.jsRound(base * 1.1));
            default:
                return "$" + Js.numStr(Js.jsRound(base * 0.8)) + "-$" + Js.numStr(Js.jsRound(base * 1.4));
        }
    }

    public String formatFlightsForAgent(List<FlightSuggestion> suggestions) {
        if (suggestions.isEmpty()) {
            return "No flight data available.";
        }
        List<String> lines = new ArrayList<>();
        for (FlightSuggestion s : suggestions) {
            lines.add("- " + s.type() + ": " + s.route() + ", ~" + s.estimatedDuration() + ", "
                    + s.estimatedPriceRange() + "\n  Search: \"" + s.searchQuery() + "\"\n  Tip: " + s.tips());
        }
        return String.join("\n", lines);
    }
}
