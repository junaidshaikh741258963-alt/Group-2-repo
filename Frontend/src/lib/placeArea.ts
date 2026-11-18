"use client";

import { useEffect, useState } from "react";

/**
 * "City, Region" line for a place card, resolved from its coordinates.
 *
 * Uses Photon (free, keyless, CORS-open) and caches per coordinate pair, so
 * opening the same place twice never refetches. Returns null while loading or
 * when nothing usable comes back — the caller then hides the line rather than
 * inventing one.
 */

const CACHE_LIMIT = 60;
const memory = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function areaKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem("tripcraft_place_area");
    if (!raw) return null;
    return (JSON.parse(raw) as Record<string, string>)[key] ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem("tripcraft_place_area");
    const all = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    all[key] = value;
    const keys = Object.keys(all);
    if (keys.length > CACHE_LIMIT) delete all[keys[0]];
    window.sessionStorage.setItem("tripcraft_place_area", JSON.stringify(all));
  } catch {
    /* storage unavailable — in-memory cache still applies */
  }
}

function format(props: Record<string, unknown>): string | null {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const city = str(props.city) || str(props.county) || str(props.district) || str(props.name);
  const region = str(props.state) || str(props.region);
  const country = str(props.country);
  if (city && region && city.toLowerCase() !== region.toLowerCase()) return `${city}, ${region}`;
  if (city) return city;
  if (region) return region;
  return country || null;
}

async function lookupArea(lat: number, lng: number): Promise<string | null> {
  const url = `https://photon.komoot.io/reverse/?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { features?: Array<{ properties?: Record<string, unknown> }> };
  const props = data.features?.[0]?.properties;
  if (!props) return null;
  return format(props);
}

/**
 * "Pune, Maharashtra" for a coordinate — fetched once, then served from cache.
 * Pass `enabled: false` to skip the lookup (e.g. when the caller already knows
 * the place's city).
 *
 * The cached reading is derived during render; state only carries what the
 * fetch added, so the effect never writes state synchronously.
 */
export function usePlaceArea(lat: number, lng: number, enabled = true): string | null {
  const key = areaKey(lat, lng);
  const usable = enabled && Number.isFinite(lat) && Number.isFinite(lng);
  /** Only the network result lives in state — keyed so a jump can't leak. */
  const [fetched, setFetched] = useState<{ key: string; value: string } | null>(null);

  const cached = usable ? (memory.get(key) ?? readStored(key) ?? null) : null;

  useEffect(() => {
    if (!usable || cached) return;
    let alive = true;
    const task =
      inflight.get(key) ??
      lookupArea(lat, lng)
        .then((value) => {
          if (value) {
            memory.set(key, value);
            writeStored(key, value);
          }
          return value;
        })
        .catch(() => null)
        .finally(() => {
          inflight.delete(key);
        });
    inflight.set(key, task);
    task.then((value) => {
      if (alive && value) setFetched({ key, value });
    });
    return () => {
      alive = false;
    };
  }, [key, usable, lat, lng, cached]);

  if (!usable) return null;
  if (cached) return cached;
  if (fetched && fetched.key === key) return fetched.value;
  return null;
}
