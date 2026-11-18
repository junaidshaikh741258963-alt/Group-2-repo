package com.tripcraft.backend.agentlib;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.places.Coord;
import com.tripcraft.backend.places.Js;
import com.tripcraft.backend.places.OsmService;

/**
 * Port of {@code src/lib/agent/index.ts} — the TripCraft planning agent:
 * gather real data from the free APIs, build the prompt, ask Gemini (with a
 * bounded retry on transient errors), fall back to Groq, and attach the raw
 * API payloads as {@code _agentData}.
 */
@Service
public class AgentService {

    private static final Logger log = LoggerFactory.getLogger(AgentService.class);

    private static final String GROQ_SYSTEM = "You are TripCraft AI Agent, an expert travel planner. "
            + "Generate detailed, personalized travel plans using real API data. Always respond with valid JSON "
            + "only. No markdown, no explanation, just the JSON object.";

    private static final Pattern TRANSIENT_GEMINI =
            Pattern.compile("503|429|UNAVAILABLE|overloaded|temporar", Pattern.CASE_INSENSITIVE);
    private static final Pattern ANY_JSON_OBJECT = Pattern.compile("\\{[\\s\\S]*\\}");
    private static final Pattern FENCE_JSON = Pattern.compile("```json\\n?");
    private static final Pattern FENCE = Pattern.compile("```\\n?");
    private static final Pattern GROQ_HINT = Pattern.compile("try again in (\\d+(?:\\.\\d+)?)", Pattern.CASE_INSENSITIVE);

    /** Never stall longer than this, whatever the Groq 429 body hints. */
    private static final long HINTED_WAIT_CAP_MS = 10_000;

    private final WeatherTool weather;
    private final HotelsTool hotelsTool;
    private final PlacesTool placesTool;
    private final FlightsTool flightsTool;
    private final RoutesTool routesTool;
    private final CurrencyTool currencyTool;

    public AgentService(WeatherTool weather, HotelsTool hotelsTool, PlacesTool placesTool,
            FlightsTool flightsTool, RoutesTool routesTool, CurrencyTool currencyTool) {
        this.weather = weather;
        this.hotelsTool = hotelsTool;
        this.placesTool = placesTool;
        this.flightsTool = flightsTool;
        this.routesTool = routesTool;
        this.currencyTool = currencyTool;
    }

    /** The eight text blocks the prompt interpolates (plus the local currency). */
    public record AgentContext(
            String weather,
            String hotels,
            String attractions,
            String flights,
            String transportOptions,
            String routes,
            String currency,
            String exchangeRates) {
    }

    // ------------------------------------------------------------ run

    public JsonNode runAgent(JsonNode form) {
        // Step 1: Gather real data from all APIs (sequential, as in the TS).
        AgentContext ctx = gatherRealData(form);

        // Step 2: Build prompt with real data
        String prompt = buildAgentPrompt(form, ctx);

        // Step 3: Gemini (retried on transient errors) with Groq as a fast fallback.
        JsonNode parsed;
        String aiProvider = firstNonBlank(EnvFile.get("GEMINI_MODEL"), "gemini-flash-latest");
        try {
            parsed = generateWithGemini(prompt);
        } catch (Exception geminiError) {
            log.error("Gemini failed, falling back to Groq:", geminiError);
            try {
                String text = groqChat(prompt);
                parsed = parseExtracted(cleanFences(text), "Groq returned invalid JSON");
                aiProvider = "groq/" + firstNonBlank(EnvFile.get("GROQ_MODEL"), "openai/gpt-oss-120b");
            } catch (Exception groqError) {
                throw new IllegalStateException("All AI providers failed — Gemini: "
                        + messageOf(geminiError) + "; Groq: " + messageOf(groqError));
            }
        }

        // Step 4: Attach raw API data for reference
        if (parsed != null && parsed.isObject()) {
            ObjectNode data = Json.obj();
            data.put("weather", ctx.weather());
            data.put("hotels", ctx.hotels());
            data.put("attractions", ctx.attractions());
            data.put("flights", ctx.flights());
            data.put("transportOptions", ctx.transportOptions());
            data.put("routes", ctx.routes());
            data.put("currency", ctx.currency());
            data.put("exchangeRates", ctx.exchangeRates());
            data.put("aiProvider", aiProvider);
            ((ObjectNode) parsed).set("_agentData", data);
        }

        return parsed;
    }

    // -------------------------------------------------------- data gather

    private AgentContext gatherRealData(JsonNode form) {
        // 1. Geocode destination
        String destination = Js.jsString(form.get("destination"));
        String origin = Js.jsString(form.get("origin"));
        String startDate = Js.jsString(form.get("startDate"));
        String endDate = Js.jsString(form.get("endDate"));
        Coord destCoords = weather.geocode(destination);
        Coord originCoords = Js.truthy(form.get("origin")) ? weather.geocode(origin) : null;

        // 2. Weather forecast
        String weatherText = "Weather data unavailable.";
        if (destCoords != null) {
            weatherText = weather.formatWeatherForAgent(
                    weather.getWeatherForecast(destCoords.lat(), destCoords.lng(), startDate, endDate));
        }

        // 3. Hotels near destination
        String hotelsText = "Hotel data unavailable.";
        if (destCoords != null) {
            hotelsText = hotelsTool.formatHotelsForAgent(
                    hotelsTool.searchHotels(destCoords.lat(), destCoords.lng(), 8, 15));
        }

        // 4. Attractions and places
        String attractionsText = "Attraction data unavailable.";
        if (destCoords != null) {
            attractionsText = placesTool.formatPlacesForAgent(
                    placesTool.searchAttractions(destCoords.lat(), destCoords.lng(), 15, 25));
        }

        // 5. Flight suggestions
        String flightsText = "Flight data unavailable.";
        if (Js.truthy(form.get("origin"))) {
            flightsText = flightsTool.formatFlightsForAgent(flightsTool.getFlightSuggestions(
                    origin, destination, startDate, endDate, Js.num(form.get("numTravelers"))));
        }

        // 6. Route between origin and destination
        String routesText = "Route data unavailable.";
        String transportOptions = "";
        if (originCoords != null && destCoords != null) {
            var route = routesTool.getDrivingRoute(
                    originCoords.lat(), originCoords.lng(), destCoords.lat(), destCoords.lng());
            if (route != null) {
                routesText = "Distance: " + route.distanceText() + ", Driving time: " + route.durationText();
                transportOptions = formatModes(routesTool.suggestTransportModes(route.distance() / 1000));
            }
        } else if (destCoords != null) {
            // Local transport only
            transportOptions = formatModes(routesTool.suggestTransportModes(20));
        }

        // 7. Currency conversion
        String exchangeRates = "Currency data unavailable.";
        try {
            Map<String, Double> rates = currencyTool.getExchangeRates("USD");
            List<String> relevantCurrencies = new ArrayList<>(rates.keySet());
            if (relevantCurrencies.size() > 15) {
                relevantCurrencies = new ArrayList<>(relevantCurrencies.subList(0, 15));
            }
            exchangeRates = "USD exchange rates: " + relevantCurrencies.stream()
                    .map(c -> c + "=" + Js.numStr(rates.get(c) == null ? Double.NaN : rates.get(c)))
                    .collect(Collectors.joining(", "));
        } catch (Exception e) {
            // silent
        }

        // 8. Local currency, guessed from the destination name
        String currency = "USD";
        if (destCoords != null) {
            String destLower = destination.toLowerCase(Locale.ROOT);
            if (destLower.contains("japan") || destLower.contains("tokyo")) {
                currency = "JPY";
            } else if (destLower.contains("europe") || destLower.contains("paris") || destLower.contains("rome")
                    || destLower.contains("berlin") || destLower.contains("barcelona")
                    || destLower.contains("amsterdam")) {
                currency = "EUR";
            } else if (destLower.contains("uk") || destLower.contains("london")) {
                currency = "GBP";
            } else if (destLower.contains("india") || destLower.contains("delhi") || destLower.contains("mumbai")) {
                currency = "INR";
            } else if (destLower.contains("thailand") || destLower.contains("bangkok")) {
                currency = "THB";
            } else if (destLower.contains("china") || destLower.contains("beijing")) {
                currency = "CNY";
            } else if (destLower.contains("korea") || destLower.contains("seoul")) {
                currency = "KRW";
            } else if (destLower.contains("brazil") || destLower.contains("rio")) {
                currency = "BRL";
            } else if (destLower.contains("mexico") || destLower.contains("cancun")) {
                currency = "MXN";
            } else if (destLower.contains("australia") || destLower.contains("sydney")) {
                currency = "AUD";
            } else if (destLower.contains("canada") || destLower.contains("toronto")) {
                currency = "CAD";
            } else if (destLower.contains("singapore")) {
                currency = "SGD";
            } else if (destLower.contains("malaysia") || destLower.contains("kuala")) {
                currency = "MYR";
            } else if (destLower.contains("uae") || destLower.contains("dubai")) {
                currency = "AED";
            } else if (destLower.contains("turkey") || destLower.contains("istanbul")) {
                currency = "TRY";
            }
        }

        return new AgentContext(weatherText, hotelsText, attractionsText, flightsText,
                transportOptions, routesText, currency, exchangeRates);
    }

    private static String formatModes(List<RoutesTool.TransportOption> modes) {
        return modes.stream()
                .map(m -> "- " + m.type() + ": " + m.description() + ", ~" + m.estimatedDuration()
                        + ", " + m.estimatedCost() + " - " + m.notes())
                .collect(Collectors.joining("\n"));
    }

    // ------------------------------------------------------------ prompt

    /**
     * {@code %s} placeholders in the exact order the TS template interpolates
     * (32 of them — extracted mechanically from {@code src/lib/agent/index.ts},
     * so the rendered prompt stays byte-identical).
     */
    static String buildAgentPrompt(JsonNode form, AgentContext ctx) {
        String interests;
        {
            // TS reads `form.interests.length` unguarded: a payload without an
            // interests array fails the request with a 500, and so does this.
            JsonNode rawInterests = Objects.requireNonNull(form.get("interests"), "interests");
            if (!rawInterests.isArray()) {
                throw new IllegalArgumentException("interests must be an array");
            }
            List<String> items = new ArrayList<>();
            for (JsonNode item : rawInterests) {
                items.add(Js.jsString(item));
            }
            interests = items.size() > 0 ? String.join(", ", items) : "General sightseeing";
        }
        String places = Js.truthy(form.get("placesToVisit"))
                ? Js.jsString(form.get("placesToVisit"))
                : "No specific places mentioned";
        String extras = Js.truthy(form.get("additionalRequirements"))
                ? Js.jsString(form.get("additionalRequirements"))
                : "None";

        String preStays = "";
        JsonNode stays = form.get("suggestedStays");
        if (stays != null && stays.isArray() && stays.size() > 0) {
            preStays = "\n### Pre-selected stays (shown to the user first — prioritize these in accommodationRecommendations)\n"
                    + bullets(stays);
        }
        String prePlaces = "";
        JsonNode suggestedPlaces = form.get("suggestedPlaces");
        if (suggestedPlaces != null && suggestedPlaces.isArray() && suggestedPlaces.size() > 0) {
            prePlaces = "\n### Pre-selected places to visit (user already saw these — weave them into the itinerary)\n"
                    + bullets(suggestedPlaces);
        }

        return String.format(Locale.ROOT, PROMPT_TEMPLATE,
                Js.jsString(form.get("origin")),
                Js.jsString(form.get("destination")),
                Js.jsString(form.get("startDate")),
                Js.jsString(form.get("endDate")),
                Js.jsString(form.get("numDays")),
                Js.jsString(form.get("numTravelers")),
                Js.jsString(form.get("numAdults")),
                Js.jsString(form.get("numChildren")),
                totalBudget(form),
                Js.jsString(form.get("transportation")),
                Js.jsString(form.get("accommodationType")),
                Js.jsString(form.get("accommodationBudget")),
                Js.jsString(form.get("foodPreference")),
                interests,
                Js.jsString(form.get("travelPace")),
                places,
                extras,
                preStays,
                prePlaces,
                ctx.weather(),
                ctx.hotels(),
                ctx.attractions(),
                ctx.flights(),
                ctx.transportOptions(),
                ctx.routes(),
                ctx.currency(),
                ctx.exchangeRates(),
                ctx.currency(),
                totalBudget(form),
                Js.jsString(form.get("numChildren")),
                totalBudget(form),
                ctx.currency());
    }

    /** TS {@code ${form.totalBudget.toLocaleString()}} — throws for a missing value, like the JS would. */
    private static String totalBudget(JsonNode form) {
        JsonNode budget = Objects.requireNonNull(form.get("totalBudget"), "totalBudget");
        if (budget.isNull()) {
            throw new NullPointerException("totalBudget");
        }
        if (budget.isNumber()) {
            return Js.toLocaleString(budget.asDouble());
        }
        return Js.jsString(budget);
    }

    private static String bullets(JsonNode array) {
        List<String> lines = new ArrayList<>();
        for (JsonNode item : array) {
            lines.add("- " + Js.jsString(item));
        }
        return String.join("\n", lines);
    }

    // ------------------------------------------------------- AI providers

    private JsonNode generateWithGemini(String prompt) throws Exception {
        String apiKey = EnvFile.get("GEMINI_API_KEY");
        if (apiKey == null || apiKey.isEmpty()) {
            throw new IllegalStateException("GEMINI_API_KEY is not set");
        }
        String model = firstNonBlank(EnvFile.get("GEMINI_MODEL"), "gemini-flash-latest");

        // Retry transient upstream errors (429/503) a couple of times.
        JsonNode response = null;
        Exception lastErr = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                response = geminiRequest(model, prompt, apiKey);
                break;
            } catch (Exception err) {
                lastErr = err;
                String msg = err.getMessage() == null ? String.valueOf(err) : err.getMessage();
                boolean transientError = TRANSIENT_GEMINI.matcher(msg).find();
                if (!transientError || attempt == 2) {
                    throw err;
                }
                // TS waits 1500ms * (attempt + 1) here; see OsmService#delay.
                OsmService.delay(1500L * (attempt + 1));
            }
        }
        if (response == null) {
            throw lastErr != null ? lastErr : new IllegalStateException("Gemini returned no response");
        }

        String text = geminiText(response);
        String cleaned = cleanFences(text).trim();
        try {
            return Json.parseOrNull(cleaned);
        } catch (Exception e) {
            // handled by parseExtracted below
        }
        return parseExtracted(cleaned, "Gemini returned invalid JSON");
    }

    private static JsonNode geminiRequest(String model, String prompt, String apiKey) {
        ObjectNode body = Json.obj();
        ObjectNode content = body.putArray("contents").addObject();
        content.put("role", "user");
        content.putArray("parts").addObject().put("text", prompt);
        ObjectNode generation = body.putObject("generationConfig");
        generation.put("temperature", 0.7);
        generation.put("maxOutputTokens", 8192);
        generation.put("responseMimeType", "application/json");

        String url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
        Http.Raw res = Http.post(url, Json.write(body), Map.of("x-goog-api-key", apiKey), 60000);
        if (!res.ok()) {
            throw new IllegalStateException("Gemini HTTP " + res.status() + ": " + snippet(res.body(), 300));
        }
        JsonNode data = res.json();
        if (data == null) {
            throw new IllegalStateException("Gemini returned invalid JSON");
        }
        return data;
    }

    /** The SDK's {@code response.text}: every candidate part concatenated, else empty. */
    private static String geminiText(JsonNode response) {
        StringBuilder sb = new StringBuilder();
        for (JsonNode candidate : Json.elements(response.get("candidates"))) {
            for (JsonNode part : Json.elements(candidate.path("content").path("parts"))) {
                if (part.path("text").isTextual()) {
                    sb.append(part.path("text").asText());
                }
            }
        }
        return sb.toString();
    }

    /**
     * Non-streaming Groq chat (port of {@code groqChat} in {@code src/lib/groq.ts}):
     * three bounded attempts, 429/503 retried after the server's own "try again
     * in Ns" hint, everything else thrown immediately.
     */
    private String groqChat(String userPrompt) throws Exception {
        String apiKey = EnvFile.get("GROQ_API_KEY");
        if (apiKey == null || apiKey.isEmpty()) {
            throw new IllegalStateException("GROQ_API_KEY is not set");
        }
        String model = firstNonBlank(EnvFile.get("GROQ_MODEL"), "openai/gpt-oss-120b");

        ObjectNode payload = Json.obj();
        payload.put("model", model);
        ArrayNode messages = payload.putArray("messages");
        messages.addObject().put("role", "system").put("content", GROQ_SYSTEM);
        messages.addObject().put("role", "user").put("content", userPrompt);
        payload.put("temperature", 0.7);
        // +headroom: reasoning shares this budget with the visible answer.
        payload.put("max_tokens", 8192 + 768);
        payload.put("reasoning_effort", "low");
        payload.put("stream", false);
        String body = Json.write(payload);
        Map<String, String> headers = Map.of(
                "Authorization", "Bearer " + apiKey,
                "Content-Type", "application/json");

        Exception lastError = new IllegalStateException("Groq request failed");
        // Delay for the NEXT attempt. Starts as the fixed backoff (800ms, then
        // 1600ms) but a 429 with a server hint overrides it.
        long nextDelayMs = 800;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                OsmService.delay(nextDelayMs);
            }
            nextDelayMs = 800L * (attempt + 1);

            Http.Raw res = Http.post("https://api.groq.com/openai/v1/chat/completions", body, headers, 60000);
            if (res.status() == 0) {
                lastError = new IllegalStateException("Groq request failed");
                continue; // network error → retry
            }
            if (res.status() == 429 || res.status() == 503) {
                lastError = new IllegalStateException(
                        "Groq error " + res.status() + ": " + snippet(res.body(), 200));
                // 429: wait out the TPM window the body reports instead of guessing.
                if (res.status() == 429) {
                    Long hint = hintedRetryDelayMs(res.body());
                    if (hint != null) {
                        nextDelayMs = hint;
                    }
                }
                continue; // rate limit / overloaded → retry after the delay above
            }
            if (res.status() < 200 || res.status() >= 300) {
                throw new IllegalStateException("Groq error " + res.status() + ": " + res.body());
            }
            JsonNode data = res.json();
            if (data == null) {
                throw new IllegalStateException("Groq returned invalid JSON: " + snippet(res.body(), 200));
            }
            String content = data.path("choices").path(0).path("message").path("content").asText("");
            return content.isEmpty() ? "" : content;
        }
        throw lastError;
    }

    /** Groq's 429 body states exactly when the per-minute token window resets. */
    private static Long hintedRetryDelayMs(String text) {
        if (text == null) {
            return null;
        }
        Matcher m = GROQ_HINT.matcher(text);
        if (!m.find()) {
            return null;
        }
        double seconds;
        try {
            seconds = Double.parseDouble(m.group(1));
        } catch (NumberFormatException e) {
            return null;
        }
        if (!Double.isFinite(seconds) || seconds <= 0) {
            return null;
        }
        return Math.min((long) Math.ceil(seconds * 1000) + 250, HINTED_WAIT_CAP_MS);
    }

    // ------------------------------------------------------------- utils

    private static String cleanFences(String text) {
        String cleaned = FENCE_JSON.matcher(text).replaceAll("");
        cleaned = FENCE.matcher(cleaned).replaceAll("");
        return cleaned.trim();
    }

    /** TS {@code JSON.parse(match(/\{[\s\S]*\}/)?.[0] ?? cleaned)} — greedy first-to-last braces. */
    private static JsonNode parseExtracted(String cleaned, String error) {
        Matcher m = ANY_JSON_OBJECT.matcher(cleaned);
        String candidate = m.find() ? m.group() : cleaned;
        JsonNode parsed = Json.parseOrNull(candidate);
        if (parsed == null) {
            throw new IllegalStateException(error);
        }
        return parsed;
    }

    private static String snippet(String text, int max) {
        if (text == null) {
            return "";
        }
        return text.length() > max ? text.substring(0, max) : text;
    }

    private static String messageOf(Throwable error) {
        return error.getMessage() != null ? error.getMessage() : "unknown";
    }

    private static String firstNonBlank(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    // ---------------------------------------------------------- template

    private static final String PROMPT_TEMPLATE = """
            You are TripCraft AI Agent, an expert autonomous travel planner. You have access to REAL-TIME data from multiple APIs. Use this data to create a personalized, day-by-day travel plan.

            ## User Trip Specifications
            - Origin: %s
            - Destination: %s
            - Travel Dates: %s to %s (%s days)
            - Travelers: %s total (%s adults, %s children)
            - Total Budget: $%s USD
            - Preferred Transportation: %s
            - Accommodation Type: %s (nightly budget: ~$%s)
            - Food Preference: %s
            - Travel Interests: %s
            - Travel Pace: %s
            - Specific Places/Activities: %s
            - Additional Requirements: %s
            %s
            %s

            ## REAL-TIME DATA FROM APIs

            ### Weather Forecast (Open-Meteo API)
            %s

            ### Hotels Near Destination (Overpass API - OpenStreetMap)
            %s

            ### Places & Attractions (Overpass API - OpenStreetMap)
            %s

            ### Flight Suggestions (Estimated - search links provided)
            %s

            ### Transport Options
            %s

            ### Route Information (OSRM)
            %s

            ### Currency & Exchange Rates (Frankfurter API)
            Local currency: %s
            %s

            ## AGENT INSTRUCTIONS
            1. You are an AI Agent with access to real data. USE the data above - don't ignore it.
            2. For flights: use the search queries provided. Tell users exactly what to search for.
            3. For hotels: reference actual hotel names from the Overpass data above.
            4. For attractions: use actual place names from the Overpass data above.
            5. For weather: plan outdoor activities on good-weather days, indoor on bad days.
            6. For budget: convert all costs to local currency (%s) using exchange rates above.
            7. For transport: use the real transport options and route data provided.
            8. DO NOT invent specific flight numbers, train times, or hotel prices not in the data.
            9. Mark genuinely uncertain items as [estimated] or [verify locally].
            10. Stay within the user's $%s USD budget.
            11. Account for children (%s children) in activity recommendations.
            12. Be specific, actionable, and personalized to the user's interests.

            ## OUTPUT FORMAT (respond in valid JSON only)
            Return a single JSON object with this exact structure:
            {
              "tripOverview": {
                "title": "string - catchy trip title",
                "summary": "string - 2-3 sentence overview using the real data gathered",
                "destination": "string",
                "duration": "string like '5 days / 4 nights'",
                "bestTimeToVisit": "string",
                "totalEstimatedCost": "string like '$1,200 - $1,500'",
                "currency": "string - local currency code"
              },
              "budgetBreakdown": {
                "transportation": "string - estimated cost range in USD",
                "accommodation": "string - estimated cost range in USD",
                "food": "string - estimated cost range in USD",
                "activities": "string - estimated cost range in USD",
                "miscellaneous": "string - estimated cost range in USD",
                "total": "string - total estimated cost in USD, must be within $%s"
              },
              "itinerary": [
                {
                  "day": 1,
                  "date": "YYYY-MM-DD",
                  "title": "string - theme for the day",
                  "weather": "string - actual weather from forecast above",
                  "activities": [
                    {
                      "time": "string like '09:00 AM'",
                      "name": "string - use REAL place names from attractions data",
                      "type": "string - attraction/restaurant/transport/hotel/activity",
                      "description": "string - detailed description",
                      "duration": "string like '2 hours'",
                      "estimatedCost": "string - in local currency %s AND USD",
                      "location": "string - area or address if known",
                      "tips": "string or empty"
                    }
                  ],
                  "meals": {
                    "breakfast": "string - restaurant/area recommendation",
                    "lunch": "string",
                    "dinner": "string"
                  },
                  "dailyBudget": "string - estimated daily spend in USD"
                }
              ],
              "transportationGuide": {
                "gettingThere": "string - how to get to destination from origin, with search queries",
                "localTransport": "string - how to get around locally",
                "tips": ["string array of transport tips"]
              },
              "accommodationRecommendations": [
                {
                  "name": "string - REAL hotel names from Overpass data",
                  "type": "string",
                  "priceRange": "string - in local currency and USD",
                  "location": "string",
                  "amenities": ["string array from real data"],
                  "whyRecommended": "string"
                }
              ],
              "foodGuide": {
                "mustTryDishes": ["string array"],
                "recommendedRestaurants": [
                  {
                    "name": "string",
                    "cuisine": "string",
                    "priceRange": "string",
                    "area": "string"
                  }
                ],
                "tips": ["string array"]
              },
              "practicalInfo": {
                "weatherSummary": "string - based on real forecast",
                "packingList": ["string array"],
                "safetyTips": ["string array"],
                "culturalNotes": ["string array"],
                "emergencyContacts": ["string array"],
                "visaInfo": "string or 'Check local requirements'"
              },
              "mapData": {
                "centerLat": 0,
                "centerLng": 0,
                "zoom": 6,
                "markers": [
                  {
                    "lat": 0,
                    "lng": 0,
                    "label": "string",
                    "type": "string - hotel/attraction/restaurant/transport"
                  }
                ]
              },
              "alternativeOptions": {
                "budgetFriendly": "string - budget-saving tips with real suggestions",
                "luxuryUpgrade": "string - how to upgrade the trip",
                "rainyDayAlternatives": ["string array - indoor activities from attractions data"]
              },
              "agentMetadata": {
                "apisUsed": ["weather", "hotels", "attractions", "flights", "routes", "currency"],
                "dataFreshness": "string - when data was fetched",
                "confidence": "string - high/medium/low based on data availability"
              }
            }

            Generate the complete JSON now. Use ALL the real data provided. Be thorough, practical, and personalized.""";
}
