"use client";

import { useEffect, useState } from "react";

/** Current conditions for the map's weather chip. */
export interface MapWeather {
  tempC: number;
  /** WMO weather interpretation in plain words, e.g. "Broken clouds". */
  label: string;
}

/** WMO 4677 codes → the wording shown on the chip. */
const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Broken clouds",
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
  82: "Violent rain showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

const STORAGE_KEY = "tripcraft_map_weather";
/** Freshness window: weather is re-fetched if the tab outlives it. */
const TTL_MS = 30 * 60 * 1000;

const memory = new Map<string, MapWeather & { at: number }>();

/** Cache key — one entry per city (falls back to a coarse grid when unnamed). */
function weatherKey(city?: string | null, lat?: number, lng?: number): string | null {
  const name = (city ?? "").trim().toLowerCase();
  if (name) return `city:${name}`;
  if (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  ) {
    return `pt:${lat.toFixed(1)},${lng.toFixed(1)}`;
  }
  return null;
}

function readStored(key: string): (MapWeather & { at: number }) | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, MapWeather & { at: number }>;
    const hit = all?.[key];
    if (!hit || typeof hit.tempC !== "number" || Date.now() - hit.at > TTL_MS) return null;
    return hit;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: MapWeather & { at: number }) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, MapWeather & { at: number }>) : {};
    all[key] = value;
    // Keep the snapshot small — one entry per city is all we ever need.
    const keys = Object.keys(all);
    if (keys.length > 12) delete all[keys[0]];
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — the in-memory cache still holds it */
  }
}

/** Open-Meteo current conditions — free, no API key. */
async function fetchWeather(lat: number, lng: number): Promise<MapWeather | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lng.toFixed(4)}&current=temperature_2m,weather_code&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
  };
  const temp = data.current?.temperature_2m;
  if (typeof temp !== "number" || !Number.isFinite(temp)) return null;
  const code = Number(data.current?.weather_code ?? 0);
  return { tempC: Math.round(temp), label: WEATHER_CODES[code] ?? "Current conditions" };
}

/**
 * Current weather for the map chip, cached per city (memory + sessionStorage)
 * so panning or re-opening a city never refetches. Returns null while loading
 * or when the lookup fails — the chip hides itself.
 *
 * The cached reading is derived during render; state only carries what the
 * fetch added, so the effect never writes state synchronously.
 */
export function useMapWeather(
  city?: string | null,
  lat?: number | null,
  lng?: number | null
): MapWeather | null {
  const key = weatherKey(city, lat ?? undefined, lng ?? undefined);
  const usable =
    key != null && lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
  /** Only the network result lives in state — keyed so a city switch can't leak. */
  const [fetched, setFetched] = useState<{ key: string; value: MapWeather } | null>(null);

  const cached = usable && key ? (memory.get(key) ?? readStored(key) ?? null) : null;

  useEffect(() => {
    if (!usable || !key || lat == null || lng == null) return;
    if (memory.get(key) ?? readStored(key)) return;
    let alive = true;
    fetchWeather(lat, lng)
      .then((found) => {
        if (!found) return;
        const entry = { ...found, at: Date.now() };
        memory.set(key, entry);
        writeStored(key, entry);
        if (alive) setFetched({ key, value: found });
      })
      .catch(() => {
        /* offline — chip simply stays hidden */
      });
    return () => {
      alive = false;
    };
  }, [key, usable, lat, lng]);

  if (!usable || !key) return null;
  if (cached) return { tempC: cached.tempC, label: cached.label };
  if (fetched && fetched.key === key) return fetched.value;
  return null;
}
