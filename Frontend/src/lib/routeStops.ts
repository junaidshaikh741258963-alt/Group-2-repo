/**
 * Stops between origin and destination — shared by the route-planner UI and
 * the `/api/route-places` endpoint so both sides agree on kinds and shapes.
 */

/** Coarse category used for icons/chips; `other` shows under "All" only. */
export type StopKind = "hotel" | "restaurant" | "cafe" | "attraction" | "shopping" | "other";

export type StopFilter = StopKind | "all";

export const STOP_CHIPS: Array<{ kind: StopFilter; label: string; emoji: string }> = [
  { kind: "all", label: "All", emoji: "✨" },
  { kind: "hotel", label: "Stays", emoji: "🏨" },
  { kind: "restaurant", label: "Food", emoji: "🍽️" },
  { kind: "cafe", label: "Cafés", emoji: "☕" },
  { kind: "attraction", label: "Sights", emoji: "🎯" },
  { kind: "shopping", label: "Shopping", emoji: "🛍️" },
];

export interface RouteStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: StopKind;
  /** Raw OSM category ("hotel", "fast_food", "gift"…). */
  category?: string;
  address?: string;
  /** `addr:city` when OSM tagged it — used to sharpen image lookups. */
  city?: string;
  /** Exact photo hints from the OSM tags (Wikidata / Wikipedia / Commons). */
  wikidata?: string;
  wikipedia?: string;
  imageTag?: string;
  /** How far the place sits from the road, in km. */
  offRouteKm: number;
  /** Distance travelled along the route when you pass it, in km. */
  alongKm: number;
  openingHours?: string;
  website?: string;
  phone?: string;
}

/** OSM tag value → one of the chip categories. */
export function normalizeStopKind(category?: string): StopKind {
  const c = (category ?? "").toLowerCase();
  if (/hotel|hostel|guest|motel|resort|lodging|chalet|apart/.test(c)) return "hotel";
  if (/restaurant|fast_food|food|pub|bar|biergarten|ice_cream/.test(c)) return "restaurant";
  if (/cafe|coffee|tea/.test(c)) return "cafe";
  if (/mall|shop|store|supermarket|gift|market|boutique|department/.test(c)) return "shopping";
  if (
    /attraction|museum|gallery|viewpoint|zoo|aquarium|theme|monument|castle|ruin|memorial|artwork|park|garden|cathedral|church|temple|archaeolog/.test(
      c
    )
  ) {
    return "attraction";
  }
  return "other";
}

/** Keep in sync with the server's MAX_PATH_POINTS (route-places). */
const MAX_PATH_POINTS = 2000;

export interface FetchRouteStopsOptions {
  /** Search corridor around the road, km (the list is filtered tighter later). */
  corridorKm?: number;
  limit?: number;
  /**
   * Progressive fetch: split the corridor's anchors into `parts` contiguous
   * groups and ask for one group per request. The UI fires all parts in
   * parallel and appends each response as it lands, so the first stretch of
   * road paints long before every Overpass query has finished.
   */
  part?: number;
  parts?: number;
  /**
   * Skip Overpass and answer from the much cheaper Nominatim fallback for the
   * whole corridor. The UI calls this once after every progressive part came
   * back empty (public Overpass outages look identical to "no places"), so the
   * panel still fills instead of showing "nothing found".
   */
  fallbackOnly?: boolean;
  signal?: AbortSignal;
}

/** Where a corridor answer came from. `none` means every source failed. */
export type RouteStopsSource = "overpass" | "nominatim" | "none";

export interface RouteStopsResult {
  places: RouteStop[];
  source: RouteStopsSource;
  /** True when the primary source actually failed (not just an empty area). */
  failed: boolean;
}

/**
 * Asks the server for everything noteworthy inside the corridor around the
 * given route geometry (`[lng, lat]` pairs, OSRM's GeoJSON order).
 */
export async function fetchRouteStopsDetailed(
  path: Array<[number, number]>,
  opts: FetchRouteStopsOptions = {}
): Promise<RouteStopsResult> {
  // Progressive mode sends the geometry once per part; the server thins to
  // 2000 points anyway, so do it here first and keep those uploads small.
  let route = path;
  if (route.length > MAX_PATH_POINTS) {
    const stride = Math.ceil(route.length / MAX_PATH_POINTS);
    const thinned: Array<[number, number]> = [];
    for (let i = 0; i < route.length; i += stride) thinned.push(route[i]);
    const last = route[route.length - 1];
    if (last && thinned[thinned.length - 1] !== last) thinned.push(last);
    route = thinned;
  }
  const res = await fetch("/api/route-places", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: route,
      corridorKm: opts.corridorKm ?? 10,
      limit: opts.limit ?? 80,
      part: opts.part ?? 0,
      parts: opts.parts ?? 1,
      fallbackOnly: opts.fallbackOnly ?? false,
    }),
    signal: opts.signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`route-places HTTP ${res.status}`);
  const data = (await res.json()) as {
    places?: RouteStop[];
    source?: RouteStopsSource;
    failed?: unknown;
  };
  const source: RouteStopsSource =
    data.source === "overpass" || data.source === "nominatim" ? data.source : "none";
  return {
    places: Array.isArray(data.places) ? data.places : [],
    source,
    failed: data.failed === true,
  };
}

/** Back-compat wrapper for callers that only need the places. */
export async function fetchRouteStops(
  path: Array<[number, number]>,
  opts: FetchRouteStopsOptions = {}
): Promise<RouteStop[]> {
  return (await fetchRouteStopsDetailed(path, opts)).places;
}

/**
 * Appends a corridor segment's stops to the list already on screen.
 *
 * Stops are deduped by their stable OSM id (falling back to name + rounded
 * coordinates for rows without one) and re-sorted in travel order, so segments
 * that overlap near an anchor boundary never produce duplicate cards. Existing
 * objects are reused; React sees the same references for untouched stops.
 */
export function mergeRouteStops(current: RouteStop[], incoming: RouteStop[]): RouteStop[] {
  if (incoming.length === 0) return current;
  const seenIds = new Set<string>();
  const seenPlaces = new Set<string>();
  const out: RouteStop[] = [];
  const placeKey = (s: RouteStop) =>
    `${s.name.trim().toLowerCase()}|${s.lat.toFixed(5)},${s.lng.toFixed(5)}`;
  const push = (stop: RouteStop) => {
    const key = placeKey(stop);
    if ((stop.id && seenIds.has(stop.id)) || seenPlaces.has(key)) return;
    if (stop.id) seenIds.add(stop.id);
    seenPlaces.add(key);
    out.push(stop);
  };
  for (const stop of current) push(stop);
  for (const stop of incoming) push(stop);
  return out.sort((a, b) => a.alongKm - b.alongKm || a.name.localeCompare(b.name));
}

/* ————— Session cache —————
   Closing the Route panel unmounts it, so re-planning the same endpoints used
   to re-run every Overpass query from scratch. The resolved list is kept per
   route (origin → destination, 4-decimal coordinates) for the tab's lifetime;
   reopening that route paints instantly with zero stop requests. */
const stopsCache = new Map<string, RouteStop[]>();
const STOPS_CACHE_MAX = 8;

export function routeStopsCacheKey(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): string {
  return `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}->${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
}

export function readRouteStopsCache(key: string): RouteStop[] | undefined {
  return stopsCache.get(key);
}

export function writeRouteStopsCache(key: string, stops: RouteStop[]): void {
  if (stops.length === 0) return; // a transient miss must not stick
  stopsCache.delete(key);
  stopsCache.set(key, stops);
  if (stopsCache.size > STOPS_CACHE_MAX) {
    const oldest = stopsCache.keys().next().value;
    if (oldest !== undefined) stopsCache.delete(oldest);
  }
}
