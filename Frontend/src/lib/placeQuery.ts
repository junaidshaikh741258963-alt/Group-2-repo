/**
 * Server-only place disambiguation for image search.
 * Turns "Le Marais" (+ its coordinates) into "Le Marais Paris France" so
 * free sources stop returning the countryside wetland, and validates that
 * result titles actually mention the place or its city.
 */

import { OSM_USER_AGENT } from "./osm";

const GEO_CACHE_MAX = 500;
const geoCache = new Map<string, { city: string | null; country: string | null }>();
/**
 * In-flight reverse geocodes, keyed like the cache. A batch of eight places
 * in the same neighbourhood used to fire eight simultaneous reverse lookups:
 * they serialised server-side, most of them timed out, and every caller
 * waited. One shared request per cell instead.
 */
const geoInflight = new Map<string, Promise<{ city: string | null; country: string | null }>>();

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "de",
  "la",
  "le",
  "les",
  "du",
  "des",
  "au",
  "aux",
  "en",
  "un",
  "une",
  "el",
  "los",
  "las",
  "il",
  "lo",
  "die",
  "der",
  "das",
  "y",
  "e",
]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of norm(s).split(" ")) {
    if (t.length > 2 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Words that name a whole CLASS of places rather than this one. A title that
 * says "museum" is not evidence it shows THIS museum — the British Museum's
 * Great Court used to fill a Pune miniature-railway museum's gallery because
 * "museum" matched its own name. Matching therefore ignores these and relies
 * on the remaining distinctive words (or the city).
 */
const GENERIC_PLACE_WORDS = new Set([
  "airport",
  "aquarium",
  "arena",
  "attraction",
  "bar",
  "beach",
  "bridge",
  "building",
  "cafe",
  "camp",
  "castle",
  "cathedral",
  "cave",
  "center",
  "centre",
  "church",
  "city",
  "club",
  "complex",
  "dam",
  "dock",
  "falls",
  "farm",
  "forest",
  "fort",
  "fountain",
  "gallery",
  "garden",
  "gardens",
  "gate",
  "harbor",
  "harbour",
  "hill",
  "hills",
  "hostel",
  "hotel",
  "house",
  "island",
  "lake",
  "library",
  "lighthouse",
  "mall",
  "market",
  "memorial",
  "monastery",
  "monument",
  "mosque",
  "mountain",
  "museum",
  "park",
  "palace",
  "pier",
  "plaza",
  "port",
  "pub",
  "reserve",
  "resort",
  "restaurant",
  "river",
  "road",
  "ruins",
  "sanctuary",
  "shrine",
  "square",
  "stadium",
  "station",
  "statue",
  "street",
  "temple",
  "theater",
  "theatre",
  "tomb",
  "tower",
  "town",
  "trail",
  "valley",
  "village",
  "waterfall",
  "woods",
  "zoo",
]);

/**
 * Nominatim sometimes returns an administrative area as the city:
 * "Jaipur Municipal Corporation" instead of "Jaipur". Appending that to a
 * photo search poisoned the query — Commons has no file matching
 * "Hawa Mahal Jaipur Municipal Corporation India", so the gallery came back
 * empty even though "Hawa Mahal Jaipur" has plenty. Strip the administrative
 * wrapper and fall back to the district when nothing usable is left.
 */
const ADMIN_CITY_SUFFIX =
  /\s+(?:municipal\s+corporation|municipal\s+council|city\s+corporation|municipality|metropolitan\s+area|urban\s+agglomeration|nagar\s+nigam|nagar\s+palika|tehsil|taluka)$/i;
const ADMIN_CITY_PREFIX = /^(?:municipality|municipal\s+corporation|municipal\s+council)\s+of\s+/i;
const ADMIN_CITY_ONLY =
  /^(?:municipal\s+corporation|municipal\s+council|city\s+corporation|municipality|metropolitan\s+area|urban\s+agglomeration|nagar\s+nigam|nagar\s+palika|tehsil|taluka)$/i;

function stripAdminWrapper(name: string): string {
  const stripped = name
    .replace(ADMIN_CITY_PREFIX, "")
    .replace(ADMIN_CITY_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim();
  // A bare "Municipal Corporation" carries no place name at all.
  return ADMIN_CITY_ONLY.test(stripped) ? "" : stripped;
}

/** The searchable city name from a Nominatim address. */
export function cleanCityName(
  raw: string | null | undefined,
  addr: Record<string, string> = {}
): string | null {
  const cleaned = stripAdminWrapper((raw ?? "").trim());
  if (cleaned) return cleaned;
  const fallback = stripAdminWrapper((addr.state_district || addr.county || "").trim());
  return fallback || null;
}

/**
 * Free reverse-geocode (Nominatim) → city + country. Cached indefinitely.
 *
 * The cache cell is ~1 km wide (two decimals), not ~100 m: a city NAME does
 * not need street precision, and a grid of nearby places then shares ONE
 * Nominatim request instead of firing one per card. Nominatim answers in
 * 0.5–1.8 s and is rate-limited, so a burst of parallel lookups was the
 * slowest part of every image lookup.
 */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ city: string | null; country: string | null }> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const pending = geoInflight.get(key);
  if (pending) return pending;
  const empty = { city: null as string | null, country: null as string | null };
  const task = (async (): Promise<{ city: string | null; country: string | null }> => {
    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse?format=json` +
        `&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          // Nominatim rejects anonymous clients with HTTP 403 "Access
          // denied" — without a User-Agent EVERY reverse lookup failed, so
          // no place could ever resolve its city from its coordinates.
          "User-Agent": OSM_USER_AGENT,
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return empty;
      const data = (await res.json()) as {
        address?: Record<string, string>;
      };
      const addr = data?.address ?? {};
      const result = {
        city: cleanCityName(
          addr.city || addr.town || addr.village || addr.municipality || addr.county,
          addr
        ),
        country: addr.country || null,
      };
      if (geoCache.size >= GEO_CACHE_MAX) {
        const oldest = geoCache.keys().next().value;
        if (oldest !== undefined) geoCache.delete(oldest);
      }
      geoCache.set(key, result);
      return result;
    } catch {
      return empty;
    } finally {
      geoInflight.delete(key);
    }
  })();
  geoInflight.set(key, task);
  return task;
}

export interface PlaceContext {
  city: string | null;
  country: string | null;
  /** "{place} {city} {country}" — always search with the full context. */
  query: string;
  placeTokens: Set<string>;
  cityTokens: Set<string>;
}

export async function resolvePlaceContext(input: {
  name: string;
  lat?: number;
  lng?: number;
  city?: string;
  country?: string;
}): Promise<PlaceContext> {
  let city = (input.city ?? "").trim() || null;
  let country = (input.country ?? "").trim() || null;
  // Only geocode when the CITY is missing. The country alone is not worth a
  // network round trip: the caller's city is what the photo guard needs, and
  // a geocode per lookup (1–6 s, rate-limited) stalled the whole image
  // chain even when the city was already known.
  if (
    !city &&
    typeof input.lat === "number" &&
    typeof input.lng === "number" &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng)
  ) {
    const geo = await reverseGeocode(input.lat, input.lng);
    city = city ?? geo.city;
    country = country ?? geo.country;
  }
  const query = [input.name.trim(), city, country].filter(Boolean).join(" ");
  return {
    city,
    country,
    query,
    placeTokens: contentTokens(input.name),
    cityTokens: new Set([...contentTokens(city ?? ""), ...contentTokens(country ?? "")]),
  };
}

/** True when a result title/source mentions the place or its city. */
export function titleMentions(
  title: string | undefined,
  ctx: Pick<PlaceContext, "placeTokens" | "cityTokens">
): boolean {
  if (!title) return false;
  const tokens = new Set(
    norm(title)
      .split(" ")
      .filter((t) => t.length > 2)
  );
  // The city (or country) is decisive: a photo titled "… Pune" really is in
  // this place's city.
  for (const t of ctx.cityTokens) {
    if (tokens.has(t)) return true;
  }
  // For the name, only distinctive words count — "museum" or "palace" alone
  // would match a same-category landmark on the other side of the world.
  for (const t of ctx.placeTokens) {
    if (!GENERIC_PLACE_WORDS.has(t) && tokens.has(t)) return true;
  }
  return false;
}
