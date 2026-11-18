package com.tripcraft.backend.rag.retrievers;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.rag.RagExec;
import com.tripcraft.backend.rag.RetrievalPlan;
import com.tripcraft.backend.rag.RetrievedDoc;
import com.tripcraft.backend.rag.RetrievalSource;
import com.tripcraft.backend.rag.Tokenizer;
import com.tripcraft.backend.rag.TtlCache;

/**
 * Live-data retriever: current hotels / restaurants / attractions / weather —
 * the port of {@code src/lib/rag/retrievers/live.ts}.
 *
 * <p>SerpAPI legs run through the shared funnel; when it is out of quota
 * (returns {@code null}) every leg degrades to the free OSM/Wikimedia-style
 * sources (Nominatim + Overpass + Open-Meteo) and, failing those, to an empty
 * list — RAG never blocks the chat on a slow upstream and never throws.
 *
 * <p>IMPORTANT: only real, sourced numbers become facts here. OSM has no live
 * prices, so OSM-sourced hotel docs deliberately omit price instead of
 * guessing one.
 */
@Component
public class LiveRetriever {

    private static final Logger log = LoggerFactory.getLogger(LiveRetriever.class);

    private static final Map<String, String> SYMBOLS = Map.of(
            "INR", "\u20b9", "USD", "$", "EUR", "\u20ac", "GBP", "\u00a3");

    /**
     * RAG-side Overpass budgets: one mirror gets ~2.5s, the whole sweep 3.5s,
     * so even a dead mirror stack leaves time for the parallel Nominatim
     * fallback before the retrieval budget fires.
     */
    private static final int OSM_TIMEOUT_MS = 2_500;
    private static final int OSM_DEADLINE_MS = 3_500;

    /** RAG-side SerpAPI budgets — every leg aborts earlier and degrades. */
    private static final int HOTEL_SERP_TIMEOUT_MS = 3_000;
    private static final int PLACES_SERP_TIMEOUT_MS = 2_500;

    /** Cache TTLs — the values of {@code config.ttl} in {@code src/server/config.ts}. */
    private static final long TTL_HOTELS_MS = 10 * 60_000L;
    private static final long TTL_PLACES_MS = 5 * 60_000L;
    private static final long TTL_GEOCODE_MS = 24 * 3_600_000L;
    private static final long TTL_WEATHER_MS = 3_600_000L;

    private static final TtlCache.Options HOTELS_OPTS =
            new TtlCache.Options(TTL_HOTELS_MS, 30 * 60_000L, false);
    private static final TtlCache.Options PLACES_OPTS =
            new TtlCache.Options(TTL_PLACES_MS, 15 * 60_000L, false);
    private static final TtlCache.Options GEOCODE_OPTS =
            new TtlCache.Options(TTL_GEOCODE_MS, null, false);
    private static final TtlCache.Options WEATHER_OPTS =
            new TtlCache.Options(TTL_WEATHER_MS, 6 * 3_600_000L, false);

    private final SerpApiService serp;

    public LiveRetriever(SerpApiService serp) {
        this.serp = serp;
    }

    /** ISO date {@code days} from now — TS {@code toISOString().slice(0, 10)} (UTC). */
    private static String isoIn(long days) {
        return LocalDate.ofInstant(Instant.now().plus(Duration.ofDays(days)), ZoneOffset.UTC).toString();
    }

    private static String originLabel(String provider) {
        return "live " + provider + " \u2014 checked just now";
    }

    // -------------------------------------------------------------- hotels

    private record HotelHit(String name, Double price, Double rating, String type, String address) {
    }

    private List<HotelHit> serpHotels(String place, String currency) {
        String key = TtlCache.cacheKey("rag:live:hotels",
                Map.of("place", place.toLowerCase(java.util.Locale.ROOT), "currency", currency));
        return TtlCache.cached(key, () -> {
            if (!serp.available()) {
                return List.of();
            }
            JsonNode data = serp.search(Map.of(
                    "engine", "google_hotels",
                    "q", "hotels in " + place,
                    "check_in_date", isoIn(14),
                    "check_out_date", isoIn(17),
                    "adults", 2,
                    "currency", currency), HOTEL_SERP_TIMEOUT_MS);
            List<HotelHit> hits = new ArrayList<>();
            for (JsonNode p : Json.elements(data == null ? null : data.get("properties"))) {
                if (hits.size() >= 12) {
                    break;
                }
                JsonNode rate = p.get("rate_per_night");
                Double price = rate != null && rate.path("extracted_lowest").isNumber()
                        ? rate.path("extracted_lowest").asDouble() : null;
                Double rating = p.path("overall_rating").isNumber()
                        ? p.path("overall_rating").asDouble() : null;
                String name = p.path("name").isTextual() ? p.path("name").asText().trim() : "";
                String type = p.path("type").isTextual() ? p.path("type").asText() : null;
                hits.add(new HotelHit(name, price, rating, type, null));
            }
            return hits;
        }, HOTELS_OPTS);
    }

    private List<HotelHit> osmHotels(String place) {
        String key = TtlCache.cacheKey("rag:live:hotels:osm",
                Map.of("place", place.toLowerCase(java.util.Locale.ROOT)));
        return TtlCache.cached(key, () -> {
            Osm.Geo geo = Osm.geocodeCenter(place);
            if (geo == null) {
                return List.of();
            }
            // Overpass and Nominatim in parallel — whichever answers feeds the
            // list, so a dead Overpass can't stall the whole retriever.
            CompletableFuture<List<Osm.OsHotel>> listFuture = CompletableFuture.supplyAsync(
                    () -> Osm.searchHotels(geo.lat(), geo.lng(), 6, 8, OSM_TIMEOUT_MS, OSM_DEADLINE_MS),
                    RagExec.pool());
            CompletableFuture<List<Osm.Point>> poisFuture = CompletableFuture.supplyAsync(
                    () -> Osm.nominatimInViewbox("hotels", geo.lat(), geo.lng(), 6, 8),
                    RagExec.pool());
            List<Osm.OsHotel> list = listFuture.join();
            List<Osm.Point> pois = poisFuture.join();

            List<HotelHit> out = new ArrayList<>();
            for (Osm.OsHotel h : list) {
                // OSM has no rating — do not invent one
                out.add(new HotelHit(h.name(), null, null,
                        h.stars() > 0 ? h.stars() + "-star listed" : null,
                        h.address()));
            }
            if (out.size() < 4) {
                for (Osm.Point p : pois) {
                    out.add(new HotelHit(p.name(), null, null,
                            p.category() != null ? p.category() + " listing" : null,
                            p.address()));
                }
            }
            return out;
        }, HOTELS_OPTS);
    }

    private RetrievedDoc hotelDoc(HotelHit hit, String currency, RetrievalPlan.Budget budget,
                                  boolean overBudget) {
        String sym = SYMBOLS.getOrDefault(currency, "INR".equals(currency) ? "\u20b9" : "$");
        List<String> parts = new ArrayList<>();
        parts.add(hit.price() != null
                ? sym + Math.round(hit.price()) + " per night"
                : "price not listed by this source");
        if (hit.rating() != null) {
            parts.add("rated " + String.format(java.util.Locale.US, "%.1f", hit.rating()) + "/5");
        }
        if (hit.type() != null) {
            parts.add(hit.type());
        }
        if (hit.address() != null) {
            parts.add(hit.address());
        }
        String text = hit.name() + " \u2014 " + String.join(", ", parts);
        if (overBudget && budget != null) {
            text += " (above your " + budget.currency() + " " + formatGrouped(budget.amount()) + " cap)";
        } else if (budget != null && hit.price() == null) {
            text += " (no price data \u2014 could not verify against your " + budget.currency()
                    + " " + formatGrouped(budget.amount()) + " cap)";
        }
        RetrievedDoc doc = RetrievedDoc.of("", RetrievalSource.LIVE, hit.name(), Tokenizer.clip(text, 400));
        doc.score(1.0);
        doc.recency(1.0);
        doc.putMeta("origin", originLabel("hotel search"));
        return doc;
    }

    /** TS {@code amount.toLocaleString()} — en-US digit grouping. */
    private static String formatGrouped(double amount) {
        return java.text.NumberFormat.getIntegerInstance(java.util.Locale.US).format(amount);
    }

    private List<RetrievedDoc> liveHotels(String place, RetrievalPlan plan) {
        RetrievalPlan.Budget budget = plan.budget();
        String currency = budget != null ? budget.currency() : "USD";

        // OSM starts at the same time as SerpAPI; when SerpAPI answers with
        // results the OSM leg is simply abandoned (the TS never awaits it).
        CompletableFuture<List<HotelHit>> osmFuture = CompletableFuture.supplyAsync(() -> {
            try {
                return osmHotels(place);
            } catch (RuntimeException e) {
                return List.<HotelHit>of();
            }
        }, RagExec.pool());
        List<HotelHit> serp;
        try {
            serp = serpHotels(place, currency);
        } catch (RuntimeException e) {
            serp = List.of();
        }
        List<HotelHit> filteredSerp = new ArrayList<>();
        for (HotelHit h : serp) {
            if (!h.name().isEmpty()) {
                filteredSerp.add(h);
            }
        }

        List<HotelHit> hits;
        if (!filteredSerp.isEmpty()) {
            hits = filteredSerp;
        } else {
            List<HotelHit> osm;
            try {
                osm = osmFuture.join();
            } catch (RuntimeException e) {
                osm = List.of();
            }
            hits = new ArrayList<>();
            for (HotelHit h : osm) {
                if (!h.name().isEmpty()) {
                    hits.add(h);
                }
            }
        }

        Set<String> seen = new LinkedHashSet<>();
        List<RetrievedDoc> docs = new ArrayList<>();
        for (HotelHit h : hits) {
            String key = h.name().toLowerCase(java.util.Locale.ROOT);
            if (!seen.add(key)) {
                continue;
            }
            docs.add(hotelDoc(h, currency, budget, false));
            if (docs.size() >= 6) {
                break;
            }
        }

        if (budget != null && !docs.isEmpty()) {
            List<HotelHit> priced = new ArrayList<>();
            for (HotelHit h : hits) {
                if (!h.name().isEmpty() && h.price() != null) {
                    priced.add(h);
                }
            }
            if (!priced.isEmpty()) {
                List<HotelHit> under = new ArrayList<>();
                List<HotelHit> over = new ArrayList<>();
                for (HotelHit h : priced) {
                    if (h.price() <= budget.amount()) {
                        under.add(h);
                    } else {
                        over.add(h);
                    }
                }
                under.sort(Comparator.comparingDouble(h -> h.price() == null ? 0 : h.price()));
                over.sort(Comparator.comparingDouble(h -> h.price() == null ? 0 : h.price()));
                List<RetrievedDoc> picked = new ArrayList<>();
                for (int i = 0; i < under.size() && i < 5; i++) {
                    picked.add(hotelDoc(under.get(i), currency, budget, false));
                }
                // Nothing under the cap → show the cheapest options, clearly
                // marked, so the model can honestly say "nothing under X".
                if (picked.size() < 3) {
                    for (int i = 0; i < over.size() && i < 3 - picked.size(); i++) {
                        picked.add(hotelDoc(over.get(i), currency, budget, true));
                    }
                }
                docs = picked;
            }
        }

        List<RetrievedDoc> out = new ArrayList<>();
        for (int i = 0; i < docs.size(); i++) {
            RetrievedDoc copy = new RetrievedDoc(docs.get(i));
            copy.id("live-hotel-" + i);
            out.add(copy);
        }
        return out;
    }

    // -------------------------------------------- restaurants & attractions

    private record PlaceHit(String name, String category, String address, String hours,
                            Double rating, String price) {
    }

    private List<RetrievedDoc> livePlaces(String place, String query) {
        String geoKey = TtlCache.cacheKey("rag:live:geo",
                Map.of("place", place.toLowerCase(java.util.Locale.ROOT)));
        Osm.Geo geo = TtlCache.cached(geoKey, () -> Osm.geocodeCenter(place), GEOCODE_OPTS);
        if (geo == null) {
            return List.of();
        }

        // Overpass (rich: hours) and Nominatim (plain but reliable) in
        // parallel; Nominatim results are only merged when the rich sources
        // are thin.
        double lat = geo.lat();
        double lng = geo.lng();
        CompletableFuture<List<PlaceHit>> osmFuture = CompletableFuture.supplyAsync(() -> {
            String key = TtlCache.cacheKey("rag:live:places", Map.of(
                    "place", place.toLowerCase(java.util.Locale.ROOT), "query", query));
            return TtlCache.cached(key, () -> {
                List<PlaceHit> hits = new ArrayList<>();
                for (Osm.Point p : Osm.overpassNearby(lat, lng, query, 5, 8,
                        OSM_TIMEOUT_MS, OSM_DEADLINE_MS)) {
                    hits.add(new PlaceHit(p.name(), p.category(), p.address(), p.openingHours(),
                            null, null));
                }
                return hits;
            }, PLACES_OPTS);
        }, RagExec.pool());
        CompletableFuture<List<PlaceHit>> nmkFuture = CompletableFuture.supplyAsync(() -> {
            String key = TtlCache.cacheKey("rag:live:nominatim", Map.of(
                    "place", place.toLowerCase(java.util.Locale.ROOT), "query", query));
            return TtlCache.cached(key, () -> {
                List<PlaceHit> hits = new ArrayList<>();
                for (Osm.Point p : Osm.nominatimInViewbox(query, lat, lng, 5, 8)) {
                    hits.add(new PlaceHit(p.name(), p.category(), p.address(), null, null, null));
                }
                return hits;
            }, PLACES_OPTS);
        }, RagExec.pool());

        List<PlaceHit> osm = osmFuture.join();
        List<PlaceHit> nmk = nmkFuture.join();
        List<PlaceHit> hits = new ArrayList<>(osm);

        // Top up with ratings/prices when free data is thin.
        if (hits.size() < 4 && serp.available()) {
            String key = TtlCache.cacheKey("rag:live:serpplaces", Map.of(
                    "place", place.toLowerCase(java.util.Locale.ROOT), "query", query));
            List<PlaceHit> serpHits = TtlCache.cached(key, () -> {
                JsonNode data = serp.search(Map.of(
                        "engine", "google_maps",
                        "q", query + " in " + place,
                        "type", "search",
                        "ll", "@" + String.format(java.util.Locale.US, "%.6f", lat)
                                + "," + String.format(java.util.Locale.US, "%.6f", lng) + ",14z",
                        "nearby", "1"), PLACES_SERP_TIMEOUT_MS);
                List<PlaceHit> out = new ArrayList<>();
                for (JsonNode p : Json.elements(data == null ? null : data.get("local_results"))) {
                    if (out.size() >= 8) {
                        break;
                    }
                    String name = p.path("title").isTextual() ? p.path("title").asText() : "";
                    String category = p.path("type").isTextual() ? p.path("type").asText() : null;
                    String address = p.path("address").isTextual() ? p.path("address").asText() : null;
                    JsonNode openState = p.get("open_state");
                    JsonNode hoursNode = openState != null && !openState.isNull() ? openState : p.get("hours");
                    String hours = hoursNode != null && hoursNode.isTextual() ? hoursNode.asText() : null;
                    Double rating = p.path("rating").isNumber() ? p.path("rating").asDouble() : null;
                    String price = p.path("price").isTextual() ? p.path("price").asText() : null;
                    out.add(new PlaceHit(name, category, address, hours, rating, price));
                }
                return out;
            }, PLACES_OPTS);
            hits.addAll(serpHits);
        }

        if (hits.size() < 3) {
            hits.addAll(nmk);
        }

        Set<String> seen = new LinkedHashSet<>();
        List<RetrievedDoc> docs = new ArrayList<>();
        for (PlaceHit h : hits) {
            String key = h.name().trim().toLowerCase(java.util.Locale.ROOT);
            if (key.isEmpty() || !seen.add(key)) {
                continue;
            }
            List<String> parts = new ArrayList<>();
            if (h.category() != null) {
                parts.add(h.category());
            }
            if (h.rating() != null) {
                parts.add("rated " + String.format(java.util.Locale.US, "%.1f", h.rating()) + "/5");
            }
            if (h.price() != null) {
                parts.add(h.price());
            }
            if (h.address() != null) {
                parts.add(h.address());
            }
            if (h.hours() != null) {
                parts.add("hours: " + h.hours());
            }
            RetrievedDoc doc = RetrievedDoc.of("live-place-" + docs.size(), RetrievalSource.LIVE,
                    h.name(), Tokenizer.clip(h.name() + " \u2014 " + String.join(", ", parts), 400));
            doc.score(1.0);
            doc.recency(1.0);
            doc.putMeta("origin", originLabel(query.contains("restaur") ? "place search" : "attraction search"));
            docs.add(doc);
            if (docs.size() >= 6) {
                break;
            }
        }
        return docs;
    }

    // ------------------------------------------------------------- weather

    private record Forecast(String date, String description, long highC, long lowC,
                            double precipitationMm, long windSpeedKmh) {
    }

    private static final Map<Integer, String> WEATHER_CODES = Map.ofEntries(
            Map.entry(0, "Clear sky"), Map.entry(1, "Mainly clear"), Map.entry(2, "Partly cloudy"),
            Map.entry(3, "Overcast"), Map.entry(45, "Fog"), Map.entry(48, "Rime fog"),
            Map.entry(51, "Light drizzle"), Map.entry(53, "Moderate drizzle"),
            Map.entry(55, "Dense drizzle"), Map.entry(61, "Slight rain"), Map.entry(63, "Moderate rain"),
            Map.entry(65, "Heavy rain"), Map.entry(71, "Slight snow"), Map.entry(73, "Moderate snow"),
            Map.entry(75, "Heavy snow"), Map.entry(80, "Slight rain showers"),
            Map.entry(81, "Moderate rain showers"), Map.entry(82, "Violent rain showers"),
            Map.entry(95, "Thunderstorm"), Map.entry(96, "Thunderstorm with hail"),
            Map.entry(99, "Thunderstorm with heavy hail"));

    private static List<Forecast> getWeatherForecast(double lat, double lng, String start, String end) {
        try {
            String url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat
                    + "&longitude=" + lng
                    + "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max"
                    + "&start_date=" + start + "&end_date=" + end + "&timezone=auto";
            JsonNode data = Http.getJson(url, 8_000);
            if (data == null) {
                return List.of();
            }
            JsonNode daily = data.get("daily");
            if (daily == null || !daily.isObject()) {
                return List.of();
            }
            List<Forecast> forecasts = new ArrayList<>();
            int maxDays = Math.min(daily.path("time").size(), 16);
            for (int i = 0; i < maxDays; i++) {
                String date = daily.path("time").get(i).asText();
                int code = daily.path("weathercode").get(i).asInt();
                String description = WEATHER_CODES.getOrDefault(code, "Code " + code);
                long highC = Math.round(daily.path("temperature_2m_max").get(i).asDouble());
                long lowC = Math.round(daily.path("temperature_2m_min").get(i).asDouble());
                double precipitation = daily.path("precipitation_sum").get(i).asDouble();
                long wind = Math.round(daily.path("windspeed_10m_max").get(i).asDouble());
                forecasts.add(new Forecast(date, description, highC, lowC, precipitation, wind));
            }
            return forecasts;
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    private List<RetrievedDoc> liveWeather(String place) {
        String geoKey = TtlCache.cacheKey("rag:live:geo",
                Map.of("place", place.toLowerCase(java.util.Locale.ROOT)));
        Osm.Geo geo = TtlCache.cached(geoKey, () -> Osm.geocodePlace(place), GEOCODE_OPTS);
        if (geo == null) {
            return List.of();
        }

        String start = isoIn(0);
        String end = isoIn(4);
        String weatherKey = TtlCache.cacheKey("rag:live:weather", Map.of(
                "place", place.toLowerCase(java.util.Locale.ROOT), "start", start, "end", end));
        List<Forecast> forecast = TtlCache.cached(weatherKey,
                () -> getWeatherForecast(geo.lat(), geo.lng(), start, end), WEATHER_OPTS);

        List<RetrievedDoc> docs = new ArrayList<>();
        for (int i = 0; i < forecast.size() && i < 5; i++) {
            Forecast f = forecast.get(i);
            RetrievedDoc doc = RetrievedDoc.of("live-weather-" + i, RetrievalSource.LIVE,
                    "Weather " + f.date() + " in " + place,
                    Tokenizer.clip(f.date() + ": " + f.description()
                            + ", high " + f.highC() + "\u00b0C / low " + f.lowC() + "\u00b0C"
                            + ", precipitation " + jsNumber(f.precipitationMm()) + " mm"
                            + ", wind " + f.windSpeedKmh() + " km/h", 260));
            doc.score(1.0);
            doc.recency(1.0);
            doc.putMeta("origin", originLabel("Open-Meteo forecast"));
            docs.add(doc);
        }
        return docs;
    }

    /** JS {@code String(number)} — no trailing {@code .0} for whole values. */
    private static String jsNumber(double value) {
        if (value == Math.rint(value) && !Double.isInfinite(value)) {
            return String.valueOf((long) value);
        }
        return String.valueOf(value);
    }

    // -------------------------------------------------------------- entry

    public List<RetrievedDoc> retrieve(RetrievalPlan plan) {
        String place = plan.place() == null ? null : plan.place().trim();
        RetrievalPlan.LiveKind kind = plan.liveKind();
        if (place == null || place.isEmpty() || kind == null) {
            return List.of();
        }
        try {
            List<RetrievedDoc> docs = switch (kind) {
                case HOTEL -> liveHotels(place, plan);
                case FOOD -> livePlaces(place, "restaurants");
                case SIGHT -> livePlaces(place, "tourist attractions");
                case WEATHER -> liveWeather(place);
            };
            if (docs.isEmpty()) {
                log.warn("[rag:live] no results for {} in \"{}\"", kind.wire(), place);
            }
            return docs;
        } catch (RuntimeException err) {
            log.warn("[rag:live] retrieval failed: {}", messageOf(err));
            return List.of();
        }
    }

    private static String messageOf(Throwable err) {
        String message = err.getMessage();
        return message != null ? message : String.valueOf(err);
    }
}
