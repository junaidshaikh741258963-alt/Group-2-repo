/**
 * Daily weather (Open-Meteo, keyless) + the "indoor swap" logic.
 *
 * Two layers:
 *  · pure helpers (types, code→label, rain detection, swap suggestions) —
 *    unit-tested, isomorphic;
 *  · a cached client fetch (`loadTripWeather`) used by the weather card, the
 *    itinerary view and the chat enrichment. Stale-while-revalidate: a cached
 *    reading up to 3 h old renders instantly while a refresh runs.
 */

export interface DailyWeather {
  /** YYYY-MM-DD */
  date: string;
  /** WMO code. */
  code: number;
  label: string;
  tempMaxC: number;
  tempMinC: number;
  precipMm: number;
  /** 0..100, when the provider gives it. */
  precipProb?: number;
}

export interface TripWeather {
  days: DailyWeather[];
  /** Epoch ms of the fetch — rendered as "updated X min ago". */
  fetchedAt: number;
  /** Destination the reading belongs to. */
  place: string;
  /** Coordinates when the client knew them; absent for place-only lookups. */
  lat?: number;
  lng?: number;
}

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Rain showers",
  82: "Violent showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm, hail",
  99: "Thunderstorm, hail",
};

export function weatherLabel(code: number): string {
  return WEATHER_CODES[code] ?? "Mixed conditions";
}

/** Rain / storm codes that justify an indoor plan. */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export function isRainy(day: Pick<DailyWeather, "code" | "precipProb" | "precipMm">): boolean {
  if (RAIN_CODES.has(day.code)) return true;
  if (day.precipProb !== undefined && day.precipProb >= 60) return true;
  return day.precipMm >= 3;
}

/** A short emoji for chips — decorative, never the only signal. */
export function weatherEmoji(code: number): string {
  if (RAIN_CODES.has(code)) return "🌧️";
  if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) return "❄️";
  if (code === 45 || code === 48) return "🌫️";
  if (code === 0 || code === 1) return "☀️";
  if (code === 2) return "⛅";
  return "☁️";
}

/** "updated 4 min ago" / "updated just now". */
export function freshness(fetchedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - fetchedAt) / 60_000));
  if (mins < 1) return "updated just now";
  if (mins < 60) return `updated ${mins} min ago`;
  const hours = Math.round(mins / 60);
  return `updated ${hours} h ago`;
}

/* ————— client fetch + cache ————— */

const MEMORY_TTL_MS = 30 * 60 * 1000;
const STORAGE_KEY = "tripcraft_trip_weather_v1";

const memory = new Map<string, TripWeather>();

function cacheKey(lat?: number, lng?: number, place?: string): string {
  if (typeof lat === "number" && typeof lng === "number") {
    return `${lat.toFixed(3)},${lng.toFixed(3)}`;
  }
  return `place:${(place ?? "").trim().toLowerCase().slice(0, 60)}`;
}

function readStored(key: string): TripWeather | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, TripWeather>;
    const hit = all[key];
    if (!hit || !Array.isArray(hit.days)) return null;
    return hit;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: TripWeather) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, TripWeather>) : {};
    all[key] = value;
    const keys = Object.keys(all);
    if (keys.length > 6) delete all[keys[0]];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function cachedWeather(lat: number, lng: number): TripWeather | null {
  const key = cacheKey(lat, lng);
  return memory.get(key) ?? readStored(key);
}

export interface WeatherRequest {
  /** Coordinates when known — otherwise the server geocodes `place`. */
  lat?: number;
  lng?: number;
  place: string;
  /** How many forecast days (1..16). */
  days?: number;
}

/** Fetch (or revalidate) daily weather. Returns null on failure — callers hide. */
export async function loadTripWeather(req: WeatherRequest): Promise<TripWeather | null> {
  const key = cacheKey(req.lat, req.lng, req.place);
  const fresh = memory.get(key);
  if (fresh && Date.now() - fresh.fetchedAt < MEMORY_TTL_MS) return fresh;

  try {
    const res = await fetch("/api/weather", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Serve stale rather than nothing.
      return fresh ?? readStored(key);
    }
    const data = (await res.json()) as { days?: unknown };
    const days = sanitizeDays(data?.days);
    if (days.length === 0) return fresh ?? readStored(key);
    const value: TripWeather = {
      days,
      fetchedAt: Date.now(),
      place: req.place,
      lat: req.lat,
      lng: req.lng,
    };
    memory.set(key, value);
    writeStored(key, value);
    return value;
  } catch {
    return fresh ?? readStored(key);
  }
}

/** Validate a raw API payload → clean DailyWeather list. */
export function sanitizeDays(raw: unknown): DailyWeather[] {
  if (!Array.isArray(raw)) return [];
  const out: DailyWeather[] = [];
  for (const d of raw.slice(0, 16)) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    const date = typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
    if (!date) continue;
    const code = typeof o.code === "number" && Number.isFinite(o.code) ? Math.round(o.code) : 0;
    const tMax = typeof o.tempMaxC === "number" && Number.isFinite(o.tempMaxC) ? o.tempMaxC : NaN;
    const tMin = typeof o.tempMinC === "number" && Number.isFinite(o.tempMinC) ? o.tempMinC : NaN;
    out.push({
      date,
      code,
      label: weatherLabel(code),
      tempMaxC: Number.isFinite(tMax) ? Math.round(tMax) : 0,
      tempMinC: Number.isFinite(tMin) ? Math.round(tMin) : 0,
      precipMm: typeof o.precipMm === "number" && Number.isFinite(o.precipMm) ? o.precipMm : 0,
      precipProb:
        typeof o.precipProb === "number" && Number.isFinite(o.precipProb)
          ? Math.max(0, Math.min(100, Math.round(o.precipProb)))
          : undefined,
    });
  }
  return out;
}
