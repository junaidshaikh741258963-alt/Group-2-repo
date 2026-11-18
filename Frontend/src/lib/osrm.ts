import { OSM_USER_AGENT } from "./osm";

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface RouteLeg {
  summary: string;
  distance: number;
  duration: number;
}

export interface RouteResponse {
  waypoints: Array<{
    location: [number, number];
    name: string;
  }>;
  routes: Array<{
    geometry: {
      coordinates: [number, number][];
      type: string;
    };
    legs: RouteLeg[];
    distance: number;
    duration: number;
  }>;
}

export interface PlaceSuggestion {
  place_name: string;
  center: [number, number];
  /** Nominatim `category` ("boundary", "place", "amenity"…). */
  category?: string;
  /** Nominatim `type` ("administrative", "city", "country"…). */
  type?: string;
  /** What the place is in the address hierarchy — "country", "city", "suburb". */
  addresstype?: string;
  /** ISO 3166-1 alpha-2 of the country the place belongs to, when known. */
  countryCode?: string;
  /** [south, north, west, east] — the place's own extent, not a point. */
  bbox?: [number, number, number, number];
}

/**
 * Free-text geocode → suggestion list.
 *
 * `countryCodes` (ISO 3166-1 alpha-2, comma separated) confines the results to
 * one or more countries — the route planner uses it so typing "Paris" after
 * picking France can never offer Paris, Texas.
 *
 * The rich fields (`addresstype`, `countryCode`, `bbox`) let callers tell a
 * country from a city: a country must not be treated as a point to sweep.
 */
export async function geocodePlace(
  query: string,
  countryCodes?: string
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    // jsonv2 carries `addresstype` + `category`; v1 drops them.
    format: "jsonv2",
    q: query,
    limit: "5",
    addressdetails: "1",
    "accept-language": "en",
  });
  const codes = countryCodes?.trim().toLowerCase();
  if (codes) params.set("countrycodes", codes);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": OSM_USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const address =
        item.address && typeof item.address === "object"
          ? (item.address as Record<string, unknown>)
          : undefined;
      const rawBox = Array.isArray(item.boundingbox) ? item.boundingbox : null;
      const box =
        rawBox && rawBox.length === 4 ? rawBox.map((v) => parseFloat(String(v))) : null;
      const bbox =
        box && box.every((n) => Number.isFinite(n))
          ? ([box[0], box[1], box[2], box[3]] as [number, number, number, number])
          : undefined;
      return {
        place_name: String(item.display_name ?? ""),
        center: [parseFloat(String(item.lon)), parseFloat(String(item.lat))] as [number, number],
        category: typeof item.category === "string" ? item.category : undefined,
        type: typeof item.type === "string" ? item.type : undefined,
        addresstype: typeof item.addresstype === "string" ? item.addresstype : undefined,
        countryCode:
          typeof address?.country_code === "string" ? address.country_code.toLowerCase() : undefined,
        bbox,
      };
    })
    .filter((s) => s.place_name && Number.isFinite(s.center[0]) && Number.isFinite(s.center[1]));
}

/**
 * Recover the country identity of a location that only knows its own centre.
 *
 * A "Recent" entry saved before countries carried an ISO code (or a
 * `?name=&lat=&lng=` link) leaves Explore treating a country as a city: the
 * point sweep around a country's centroid finds nothing, so the grid says
 * "No results found" forever. Given the geocoder's suggestions for the name,
 * return the code when the coordinates are the country's own centre — the
 * coordinate check is what keeps a town that shares the country's name
 * ("Russia, Ohio") from being mistaken for it.
 */
export function countryCodeForPlace(
  place: { lat: number; lng: number },
  suggestions: PlaceSuggestion[]
): string | null {
  for (const s of suggestions) {
    if (s.addresstype !== "country") continue;
    const code = s.countryCode?.toLowerCase();
    if (!code || !/^[a-z]{2}$/.test(code)) continue;
    // Same point (within a degree of slop for geocoder rounding).
    if (Math.abs(s.center[1] - place.lat) > 1 || Math.abs(s.center[0] - place.lng) > 1) continue;
    return code;
  }
  return null;
}

export async function getRoute(
  origin: Coordinates,
  destination: Coordinates
): Promise<RouteResponse> {
  // Routes are deterministic for a given pair of points and the public OSRM
  // demo server is shared, so a re-plan of the same journey (swap panels,
  // re-open the planner) should never pay for the same request twice.
  const key = `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}|${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < ROUTE_CACHE_TTL_MS) return hit.value;

  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("Failed to fetch route");
  const data = (await res.json()) as RouteResponse;
  if (!Array.isArray(data?.routes) || data.routes.length === 0) {
    throw new Error("No route found");
  }
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined) routeCache.delete(oldest);
  }
  routeCache.set(key, { at: Date.now(), value: data });
  return data;
}

const ROUTE_CACHE_TTL_MS = 10 * 60_000;
const ROUTE_CACHE_MAX = 12;
const routeCache = new Map<string, { at: number; value: RouteResponse }>();

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  return `${hours}h ${minutes}min`;
}
