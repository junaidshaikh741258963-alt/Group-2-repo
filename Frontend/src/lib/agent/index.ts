import { geocode, getWeatherForecast, formatWeatherForAgent } from "./weather";
import { searchHotels, formatHotelsForAgent } from "./hotels";
import { searchAttractions, formatPlacesForAgent } from "./places";
import { getFlightSuggestions, formatFlightsForAgent } from "./flights";
import { getDrivingRoute, suggestTransportModes } from "./routes";
import { getExchangeRates } from "./currency";
import { llmChat, llmProviderLabel } from "../llm";

export interface AgentInput {
  origin: string;
  destination: string;
  startDate: string;
  endDate: string;
  numDays: number;
  numTravelers: number;
  numAdults: number;
  numChildren: number;
  totalBudget: number;
  transportation: string;
  accommodationType: string;
  accommodationBudget: number;
  foodPreference: string;
  interests: string[];
  travelPace: string;
  placesToVisit: string;
  additionalRequirements: string;
  suggestedStays?: string[];
  suggestedPlaces?: string[];
}

export interface AgentContext {
  weather: string;
  hotels: string;
  attractions: string;
  flights: string;
  transportOptions: string;
  routes: string;
  currency: string;
  exchangeRates: string;
}

async function gatherRealData(form: AgentInput): Promise<AgentContext> {
  // 1. Geocode destination
  const destCoords = await geocode(form.destination);
  const originCoords = form.origin ? await geocode(form.origin) : null;

  // 2. Weather forecast
  let weather = "Weather data unavailable.";
  if (destCoords) {
    const forecasts = await getWeatherForecast(
      destCoords.lat,
      destCoords.lng,
      form.startDate,
      form.endDate
    );
    weather = formatWeatherForAgent(forecasts);
  }

  // 3. Hotels near destination
  let hotels = "Hotel data unavailable.";
  if (destCoords) {
    const hotelResults = await searchHotels(destCoords.lat, destCoords.lng, 8, 15);
    hotels = formatHotelsForAgent(hotelResults);
  }

  // 4. Attractions and places
  let attractions = "Attraction data unavailable.";
  if (destCoords) {
    const places = await searchAttractions(destCoords.lat, destCoords.lng, 15, 25);
    attractions = formatPlacesForAgent(places);
  }

  // 5. Flight suggestions
  let flights = "Flight data unavailable.";
  if (form.origin) {
    const flightSuggestions = await getFlightSuggestions(
      form.origin,
      form.destination,
      form.startDate,
      form.endDate,
      form.numTravelers
    );
    flights = formatFlightsForAgent(flightSuggestions);
  }

  // 6. Route between origin and destination
  let routes = "Route data unavailable.";
  let transportOptions = "";
  if (originCoords && destCoords) {
    const route = await getDrivingRoute(
      originCoords.lat,
      originCoords.lng,
      destCoords.lat,
      destCoords.lng
    );
    if (route) {
      const distKm = route.distance / 1000;
      routes = `Distance: ${route.distanceText}, Driving time: ${route.durationText}`;
      const modes = suggestTransportModes(distKm);
      transportOptions = modes
        .map(
          (m) =>
            `- ${m.type}: ${m.description}, ~${m.estimatedDuration}, ${m.estimatedCost} - ${m.notes}`
        )
        .join("\n");
    }
  } else if (destCoords) {
    // Local transport only
    const modes = suggestTransportModes(20);
    transportOptions = modes
      .map(
        (m) =>
          `- ${m.type}: ${m.description}, ~${m.estimatedDuration}, ${m.estimatedCost} - ${m.notes}`
      )
      .join("\n");
  }

  // 7. Currency conversion
  let exchangeRates = "Currency data unavailable.";
  try {
    const rates = await getExchangeRates("USD");
    const relevantCurrencies = Object.keys(rates).slice(0, 15);
    exchangeRates = `USD exchange rates: ${relevantCurrencies.map((c) => `${c}=${rates[c]}`).join(", ")}`;
  } catch {
    // silent
  }

  let currency = "USD";
  if (destCoords) {
    // Try to determine local currency from destination name
    const destLower = form.destination.toLowerCase();
    if (destLower.includes("japan") || destLower.includes("tokyo")) currency = "JPY";
    else if (
      destLower.includes("europe") ||
      destLower.includes("paris") ||
      destLower.includes("rome") ||
      destLower.includes("berlin") ||
      destLower.includes("barcelona") ||
      destLower.includes("amsterdam")
    )
      currency = "EUR";
    else if (destLower.includes("uk") || destLower.includes("london")) currency = "GBP";
    else if (
      destLower.includes("india") ||
      destLower.includes("delhi") ||
      destLower.includes("mumbai")
    )
      currency = "INR";
    else if (destLower.includes("thailand") || destLower.includes("bangkok")) currency = "THB";
    else if (destLower.includes("china") || destLower.includes("beijing")) currency = "CNY";
    else if (destLower.includes("korea") || destLower.includes("seoul")) currency = "KRW";
    else if (destLower.includes("brazil") || destLower.includes("rio")) currency = "BRL";
    else if (destLower.includes("mexico") || destLower.includes("cancun")) currency = "MXN";
    else if (destLower.includes("australia") || destLower.includes("sydney")) currency = "AUD";
    else if (destLower.includes("canada") || destLower.includes("toronto")) currency = "CAD";
    else if (destLower.includes("singapore")) currency = "SGD";
    else if (destLower.includes("malaysia") || destLower.includes("kuala")) currency = "MYR";
    else if (destLower.includes("uae") || destLower.includes("dubai")) currency = "AED";
    else if (destLower.includes("turkey") || destLower.includes("istanbul")) currency = "TRY";
  }

  return {
    weather,
    hotels,
    attractions,
    flights,
    transportOptions,
    routes,
    currency,
    exchangeRates,
  };
}

function buildAgentPrompt(form: AgentInput, ctx: AgentContext): string {
  const interests = form.interests.length > 0 ? form.interests.join(", ") : "General sightseeing";
  const places = form.placesToVisit || "No specific places mentioned";
  const extras = form.additionalRequirements || "None";
  const preStays =
    form.suggestedStays && form.suggestedStays.length > 0
      ? `\n### Pre-selected stays (shown to the user first — prioritize these in accommodationRecommendations)\n${form.suggestedStays
          .map((s) => `- ${s}`)
          .join("\n")}`
      : "";
  const prePlaces =
    form.suggestedPlaces && form.suggestedPlaces.length > 0
      ? `\n### Pre-selected places to visit (user already saw these — weave them into the itinerary)\n${form.suggestedPlaces
          .map((s) => `- ${s}`)
          .join("\n")}`
      : "";

  return `You are TripCraft AI Agent, an expert autonomous travel planner. You have access to REAL-TIME data from multiple APIs. Use this data to create a personalized, day-by-day travel plan.

## User Trip Specifications
- Origin: ${form.origin}
- Destination: ${form.destination}
- Travel Dates: ${form.startDate} to ${form.endDate} (${form.numDays} days)
- Travelers: ${form.numTravelers} total (${form.numAdults} adults, ${form.numChildren} children)
- Total Budget: $${form.totalBudget.toLocaleString()} USD
- Preferred Transportation: ${form.transportation}
- Accommodation Type: ${form.accommodationType} (nightly budget: ~$${form.accommodationBudget})
- Food Preference: ${form.foodPreference}
- Travel Interests: ${interests}
- Travel Pace: ${form.travelPace}
- Specific Places/Activities: ${places}
- Additional Requirements: ${extras}
${preStays}
${prePlaces}

## REAL-TIME DATA FROM APIs

### Weather Forecast (Open-Meteo API)
${ctx.weather}

### Hotels Near Destination (Overpass API - OpenStreetMap)
${ctx.hotels}

### Places & Attractions (Overpass API - OpenStreetMap)
${ctx.attractions}

### Flight Suggestions (Estimated - search links provided)
${ctx.flights}

### Transport Options
${ctx.transportOptions}

### Route Information (OSRM)
${ctx.routes}

### Currency & Exchange Rates (Frankfurter API)
Local currency: ${ctx.currency}
${ctx.exchangeRates}

## AGENT INSTRUCTIONS
1. You are an AI Agent with access to real data. USE the data above - don't ignore it.
2. For flights: use the search queries provided. Tell users exactly what to search for.
3. For hotels: reference actual hotel names from the Overpass data above.
4. For attractions: use actual place names from the Overpass data above.
5. For weather: plan outdoor activities on good-weather days, indoor on bad days.
6. For budget: convert all costs to local currency (${ctx.currency}) using exchange rates above.
7. For transport: use the real transport options and route data provided.
8. DO NOT invent specific flight numbers, train times, or hotel prices not in the data.
9. Mark genuinely uncertain items as [estimated] or [verify locally].
10. Stay within the user's $${form.totalBudget.toLocaleString()} USD budget.
11. Account for children (${form.numChildren} children) in activity recommendations.
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
    "total": "string - total estimated cost in USD, must be within $${form.totalBudget.toLocaleString()}"
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
          "estimatedCost": "string - in local currency ${ctx.currency} AND USD",
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

Generate the complete JSON now. Use ALL the real data provided. Be thorough, practical, and personalized.`;
}

export async function runAgent(form: AgentInput): Promise<unknown> {
  // Step 1: Gather real data from all APIs in parallel
  const ctx = await gatherRealData(form);

  // Step 2: Build prompt with real data
  const prompt = buildAgentPrompt(form, ctx);

  // Step 3: one OpenAI-compatible call — works with Groq, Gemini, OpenAI or
  // any compatible gateway, selected purely by env (see `lib/llm.ts`).
  const promptMessages = [
    {
      role: "system" as const,
      content:
        "You are TripCraft AI Agent, an expert travel planner. Generate detailed, personalized travel plans using real API data. Always respond with valid JSON only. No markdown, no explanation, just the JSON object.",
    },
    { role: "user" as const, content: prompt },
  ];

  let parsed: Record<string, unknown>;
  try {
    const text = await llmChat(promptMessages, {
      temperature: 0.7,
      maxTokens: 8192,
      json: true,
    });
    parsed = parseJsonObject(text);
  } catch (error) {
    throw new Error(
      `AI provider failed (${llmProviderLabel()}): ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  // Step 4: Attach raw API data for reference
  parsed._agentData = {
    weather: ctx.weather,
    hotels: ctx.hotels,
    attractions: ctx.attractions,
    flights: ctx.flights,
    transportOptions: ctx.transportOptions,
    routes: ctx.routes,
    currency: ctx.currency,
    exchangeRates: ctx.exchangeRates,
    aiProvider: llmProviderLabel(),
  };

  return parsed;
}

/** Strip markdown fences and pull the first JSON object out of a reply. */
function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error("AI provider returned invalid JSON");
  }
}
