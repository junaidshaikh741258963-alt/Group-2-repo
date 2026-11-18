import { geocodePlace } from "./osrm";

export interface CardCoords {
  lat: number;
  lng: number;
}

/**
 * Coordinates for a chat card the model could not place. The AI prompt allows
 * the model to omit lat/lng when it is unsure, but the card still renders — so
 * tapping it must not be a dead end. This resolves the missing pair on demand,
 * one query at a time (Nominatim asks clients to stay around 1 req/s), and
 * caches both hits and misses for the session.
 */
const cache = new Map<string, CardCoords | null>();
const pending = new Map<string, Promise<CardCoords | null>>();
const CACHE_LIMIT = 200;
let queue: Promise<unknown> = Promise.resolve();

function queryFor(name: string, city?: string | null): string {
  return [name.trim(), city?.trim()].filter(Boolean).join(", ");
}

export function resolvePlaceCoords(
  name: string,
  city?: string | null
): Promise<CardCoords | null> {
  const query = queryFor(name, city);
  // A bare "a" is never a place worth spending a geocoder request on.
  if (query.length < 2) return Promise.resolve(null);

  const key = query.toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const run = queue.then(async () => {
    if (cache.has(key)) return cache.get(key) ?? null;
    const suggestions = await geocodePlace(query).catch(() => []);
    const first = suggestions[0];
    const coords = first ? { lat: first.center[1], lng: first.center[0] } : null;
    cache.set(key, coords);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    pending.delete(key);
    return coords;
  });

  pending.set(key, run);
  queue = run.catch(() => undefined);
  return run;
}
