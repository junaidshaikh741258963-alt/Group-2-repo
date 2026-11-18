package com.tripcraft.backend.agentlib;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Coord;
import com.tripcraft.backend.places.Js;

/**
 * Port of {@code src/lib/agent/weather.ts} — Nominatim geocoding plus the
 * Open-Meteo forecast, formatted for the agent prompt.
 */
@Service
public class WeatherTool {

    /** One day of the Open-Meteo daily forecast. */
    public record WeatherForecast(
            String date,
            String description,
            double highC,
            double lowC,
            double precipitationMm,
            double windSpeedKmh,
            double weatherCode) {
    }

    private static final Map<Integer, String> WEATHER_CODES = weatherCodes();

    private static Map<Integer, String> weatherCodes() {
        Map<Integer, String> m = new LinkedHashMap<>();
        m.put(0, "Clear sky");
        m.put(1, "Mainly clear");
        m.put(2, "Partly cloudy");
        m.put(3, "Overcast");
        m.put(45, "Fog");
        m.put(48, "Rime fog");
        m.put(51, "Light drizzle");
        m.put(53, "Moderate drizzle");
        m.put(55, "Dense drizzle");
        m.put(61, "Slight rain");
        m.put(63, "Moderate rain");
        m.put(65, "Heavy rain");
        m.put(71, "Slight snow");
        m.put(73, "Moderate snow");
        m.put(75, "Heavy snow");
        m.put(80, "Slight rain showers");
        m.put(81, "Moderate rain showers");
        m.put(82, "Violent rain showers");
        m.put(95, "Thunderstorm");
        m.put(96, "Thunderstorm with hail");
        m.put(99, "Thunderstorm with heavy hail");
        return m;
    }

    /** Free Nominatim geocode. Always resolves — {@code null} means "no match". */
    public Coord geocode(String place) {
        try {
            String url = "https://nominatim.openstreetmap.org/search?format=json&q="
                    + Js.encode(place == null ? "" : place) + "&limit=1";
            Http.Raw res = Http.get(url, Map.of("User-Agent", "TripCraftAI/1.0"), 8000);
            JsonNode data = res.json();
            if (data != null && data.isArray() && data.size() > 0) {
                JsonNode first = data.get(0);
                // TS does not validate here: a match with bad coordinates still yields a
                // (NaN) point, and downstream tools degrade exactly the same way.
                double lat = Js.parseFloat(Js.jsString(first.path("lat")));
                double lng = Js.parseFloat(Js.jsString(first.path("lon")));
                return new Coord(lat, lng);
            }
        } catch (Exception e) {
            // silent
        }
        return null;
    }

    public List<WeatherForecast> getWeatherForecast(double lat, double lng, String startDate, String endDate) {
        try {
            String url = "https://api.open-meteo.com/v1/forecast?latitude=" + Js.numStr(lat)
                    + "&longitude=" + Js.numStr(lng)
                    + "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max"
                    + "&start_date=" + Js.encode(startDate) + "&end_date=" + Js.encode(endDate) + "&timezone=auto";
            Http.Raw res = Http.get(url, Map.of(), 20000);
            if (!res.ok()) {
                return List.of();
            }
            JsonNode data = res.json();
            JsonNode daily = data == null ? null : data.get("daily");
            if (daily == null || !daily.isObject()) {
                return List.of();
            }
            JsonNode times = daily.get("time");
            if (times == null || !times.isArray()) {
                return List.of();
            }

            List<WeatherForecast> forecasts = new ArrayList<>();
            int maxDays = Math.min(times.size(), 16);
            for (int i = 0; i < maxDays; i++) {
                double code = numAt(daily, "weathercode", i);
                forecasts.add(new WeatherForecast(
                        Js.jsString(times.get(i)),
                        describeCode(code),
                        Js.jsRound(numAt(daily, "temperature_2m_max", i)),
                        Js.jsRound(numAt(daily, "temperature_2m_min", i)),
                        numAt(daily, "precipitation_sum", i),
                        Js.jsRound(numAt(daily, "windspeed_10m_max", i)),
                        code));
            }
            return forecasts;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** JS array indexing: a missing row reads as {@code NaN}, not 0. */
    private static double numAt(JsonNode daily, String field, int index) {
        JsonNode arr = daily.get(field);
        if (arr == null || !arr.isArray() || index >= arr.size()) {
            return Double.NaN;
        }
        JsonNode v = arr.get(index);
        return v != null && v.isNumber() ? v.asDouble() : Double.NaN;
    }

    private static String describeCode(double code) {
        if (Double.isFinite(code) && code == Math.rint(code)) {
            String known = WEATHER_CODES.get((int) code);
            if (known != null) {
                return known;
            }
        }
        return "Code " + Js.numStr(code);
    }

    public String formatWeatherForAgent(List<WeatherForecast> forecasts) {
        if (forecasts.isEmpty()) {
            return "Weather data unavailable.";
        }
        List<String> lines = new ArrayList<>();
        for (WeatherForecast f : forecasts) {
            lines.add(f.date() + ": " + f.description()
                    + ", High " + Js.numStr(f.highC()) + "°C / Low " + Js.numStr(f.lowC())
                    + "°C, Precip " + Js.numStr(f.precipitationMm()) + "mm, Wind "
                    + Js.numStr(f.windSpeedKmh()) + "km/h");
        }
        return String.join("\n", lines);
    }

    public boolean isGoodWeatherDay(WeatherForecast forecast) {
        return forecast.weatherCode() <= 3 && forecast.precipitationMm() < 2;
    }
}
