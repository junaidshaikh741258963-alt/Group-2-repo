import { z } from "zod";
import { NextRequest } from "next/server";
import { fetchJson } from "@/server/http";
import { enforceRateLimit } from "@/server/rateLimit";
import { geocodeCenter } from "@/lib/osm";

export const runtime = "nodejs";

/**
 * Daily weather for the trip (Open-Meteo, keyless).
 *
 * Accepts either coordinates or a destination name (geocoded server-side when
 * needed). Server-cached for 30 minutes per rounded location so a chat reply,
 * the weather card and the itinerary chips share one upstream call. The client
 * adds its own stale-while-revalidate layer and renders the "updated X ago"
 * stamp from `fetchedAt`.
 */

const RequestSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    place: z.string().max(80).optional(),
    days: z.coerce.number().int().min(1).max(16).optional(),
  })
  .refine((v) => (v.lat !== undefined && v.lng !== undefined) || (v.place ?? "").trim().length >= 2, {
    message: "Provide lat+lng or a place name.",
  });

interface OpenMeteoResponse {
  daily?: {
    time?: string[];
    weather_code?: number[];
    weathercode?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    precipitation_probability?: number[];
  };
}

interface WeatherDay {
  date: string;
  code: number;
  tempMaxC: number;
  tempMinC: number;
  precipMm: number;
  precipProb?: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; days: WeatherDay[] }>();
const MAX_CACHE = 200;

function cacheKey(lat: number, lng: number, days: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}:${days}`;
}

export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, { scope: "weather", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid coordinates or day count." }, { status: 400 });
  }
  const days = parsed.data.days ?? 7;

  let lat = parsed.data.lat;
  let lng = parsed.data.lng;
  if (lat === undefined || lng === undefined) {
    const geo = await geocodeCenter(parsed.data.place!.trim()).catch(() => null);
    if (!geo) {
      return Response.json({ error: "Could not locate that place." }, { status: 404 });
    }
    lat = geo.lat;
    lng = geo.lng;
  }

  const key = cacheKey(lat, lng, days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json(
      { days: hit.days, fetchedAt: hit.at, cached: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability` +
    `&forecast_days=${days}&timezone=auto`;

  try {
    const data = await fetchJson<OpenMeteoResponse>(url, { timeoutMs: 8_000, attempts: 2 });
    const daily = data.daily ?? {};
    const codes = daily.weather_code ?? daily.weathercode ?? [];
    const times = daily.time ?? [];
    const out: WeatherDay[] = [];
    for (let i = 0; i < times.length && i < days; i++) {
      const code = typeof codes[i] === "number" ? codes[i] : 0;
      out.push({
        date: times[i],
        code,
        tempMaxC: daily.temperature_2m_max?.[i] ?? 0,
        tempMinC: daily.temperature_2m_min?.[i] ?? 0,
        precipMm: daily.precipitation_sum?.[i] ?? 0,
        precipProb: daily.precipitation_probability?.[i],
      });
    }
    if (out.length === 0) {
      return Response.json({ error: "Weather provider returned no days." }, { status: 502 });
    }
    if (cache.size >= MAX_CACHE) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(key, { at: Date.now(), days: out });
    return Response.json(
      { days: out, fetchedAt: Date.now(), cached: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // Serve stale over nothing when the provider is down.
    if (hit) {
      return Response.json(
        { days: hit.days, fetchedAt: hit.at, cached: true, stale: true },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json({ error: "Weather is unavailable right now." }, { status: 502 });
  }
}
