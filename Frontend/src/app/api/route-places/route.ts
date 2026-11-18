import { NextRequest } from "next/server";
import { haversineKm, nominatimInViewbox, overpassAlongAnchors, type OsmPoint } from "@/lib/osm";
import { reverseGeocode } from "@/lib/placeQuery";
import { normalizeStopKind, type RouteStop, type RouteStopsSource } from "@/lib/routeStops";

export const runtime = "nodejs";

/**
 * Everything worth stopping for *between* an origin and a destination.
 *
 * The client posts the route polyline (OSRM GeoJSON `[lng, lat]` pairs); we
 * spread a handful of anchors along it, ask Overpass for every category in one
 * unioned request, then project each hit onto the polyline so the response
 * carries both "how far off the road" and "when you'd reach it".
 */

/** Categories to look for along the road — unioned into one Overpass query. */
const CORRIDOR_QUERIES = [
  "hotel",
  "restaurants",
  "cafes",
  "tourist attractions",
  "landmark monuments",
  "shopping",
];

/** One anchor per this many km of road (bounds query size on long routes). */
const ANCHOR_SPACING_KM = 120;
const MIN_ANCHORS = 3;
/** Matches `overpassAlongAnchors`' own cap — beyond this the union query
 *  stops finishing inside the public instances' timeout. */
const MAX_ANCHORS = 6;
/** GeoJSON is denser than we need — projections stay accurate well below this. */
const MAX_PATH_POINTS = 2000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

type Pt = [number, number];

/** Keeps the polyline's shape while capping how many vertices we scan. */
function thinPath(pts: Pt[], max: number): Pt[] {
  if (pts.length <= max) return pts;
  const stride = Math.ceil(pts.length / max);
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i += stride) out.push(pts[i]);
  const last = pts[pts.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Cumulative distance to each vertex, in km. */
function cumulativeKm(path: Pt[]): number[] {
  const cum = new Array<number>(path.length);
  cum[0] = 0;
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    cum[i] =
      (cum[i - 1] ?? 0) + haversineKm({ lat: prev[1], lng: prev[0] }, { lat: cur[1], lng: cur[0] });
  }
  return cum;
}

/** Nearest point on the polyline → how far off it is and when you pass it. */
function project(path: Pt[], cum: number[], lng: number, lat: number) {
  let offKm = Infinity;
  let alongKm = 0;
  for (let i = 0; i < path.length; i++) {
    const vertex = path[i];
    const d = haversineKm({ lat: vertex[1], lng: vertex[0] }, { lat, lng });
    if (d < offKm) {
      offKm = d;
      alongKm = cum[i] ?? 0;
    }
  }
  return { offKm, alongKm };
}

/** Points spread evenly along the road, at most `max` of them. */
function anchors(
  path: Pt[],
  cum: number[],
  totalKm: number,
  max: number
): Array<{ lat: number; lng: number }> {
  const count = clamp(
    Math.ceil(totalKm / ANCHOR_SPACING_KM),
    MIN_ANCHORS,
    Math.min(max, MAX_ANCHORS)
  );
  const out: Array<{ lat: number; lng: number }> = [];
  for (let i = 1; i <= count; i++) {
    const target = (totalKm * i) / (count + 1);
    let idx = 0;
    while (idx < cum.length - 1 && (cum[idx + 1] ?? 0) < target) idx++;
    const pt = path[idx];
    if (pt) out.push({ lat: pt[1], lng: pt[0] });
  }
  return out;
}

/** Points at 25/50/75% along the road — where a driver would actually stop. */
function corridorSamples(shape: Pt[]): Pt[] {
  if (shape.length === 0) return [];
  return [0.25, 0.5, 0.75].map(
    (t) => shape[Math.min(shape.length - 1, Math.floor(shape.length * t))]
  );
}

/** Splits anchors into `parts` contiguous groups, in travel order. */
function splitAnchors<T>(items: T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  if (items.length === 0) return out;
  items.forEach((item, i) => {
    const slot = Math.min(parts - 1, Math.floor((i * parts) / items.length));
    out[slot].push(item);
  });
  return out;
}

/** Stable identity: OSM id when known, coordinates otherwise. */
function stopId(p: OsmPoint): string {
  if (p.osmType && typeof p.osmId === "number") return `osm:${p.osmType}/${p.osmId}`;
  return `stop-${p.lat.toFixed(5)}_${p.lng.toFixed(5)}`;
}

interface CityHint {
  lat: number;
  lng: number;
  city: string | null;
}

/**
 * City names for this chunk's anchors. Runs while the Overpass sweep is
 * still working, so it costs no extra latency — and the cap is generous
 * because the sweep itself can take tens of seconds on a busy mirror: a
 * hint that lands with the sweep is free, and it saves every stop its own
 * reverse-geocode later (the image lookups need the city).
 */
async function withCityHints(points: Array<{ lat: number; lng: number }>): Promise<CityHint[]> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000));
  const lookups = Promise.all(
    points.map((p) => reverseGeocode(p.lat, p.lng).catch(() => ({ city: null as string | null })))
  );
  const geo = await Promise.race([lookups, timeout]);
  return points.map((p, i) => ({
    lat: p.lat,
    lng: p.lng,
    city: geo?.[i]?.city ?? null,
  }));
}

/** Nearest anchor city — accurate at corridor scale, never crosses the globe. */
function nearestCity(lat: number, lng: number, hints: CityHint[]): string | undefined {
  let best: string | undefined;
  let bestKm = Infinity;
  for (const h of hints) {
    if (!h.city) continue;
    const km = haversineKm({ lat, lng }, h);
    if (km < bestKm) {
      bestKm = km;
      best = h.city;
    }
  }
  return best;
}

/** Projects raw OSM hits onto the route and keeps the ones inside the corridor. */
function toRouteStops(
  hits: OsmPoint[],
  shape: Pt[],
  cum: number[],
  corridorKm: number,
  limit: number,
  cityHints: CityHint[] = []
): RouteStop[] {
  const seen = new Set<string>();
  const places: RouteStop[] = [];
  for (const p of hits) {
    const key = `${p.name.trim().toLowerCase()}|${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { offKm, alongKm } = project(shape, cum, p.lng, p.lat);
    if (offKm > corridorKm) continue;
    places.push({
      id: stopId(p),
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      kind: normalizeStopKind(p.category),
      category: p.category,
      address: p.address,
      city: p.city || nearestCity(p.lat, p.lng, cityHints),
      wikidata: p.wikidata,
      wikipedia: p.wikipedia,
      imageTag: p.imageTag,
      offRouteKm: Math.round(offKm * 10) / 10,
      alongKm: Math.round(alongKm * 10) / 10,
      openingHours: p.openingHours,
      website: p.website,
      phone: p.phone,
    });
    if (places.length >= limit) break;
  }
  // Route order: what you reach first comes first.
  places.sort((a, b) => a.alongKm - b.alongKm);
  return places;
}

/**
 * Last resort when every Overpass mirror is down: three category searches
 * spread along the road, a second apart to respect Nominatim's rate limit.
 */
async function nominatimCorridorFallback(shape: Pt[], limit: number): Promise<OsmPoint[]> {
  const pts = corridorSamples(shape);
  const queries = ["restaurants", "tourist attractions", "hotels"];
  const perPoint = Math.max(4, Math.ceil(limit / Math.max(pts.length, 1)));
  const out: OsmPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    const q = queries[i];
    if (!pt || !q) continue;
    if (i > 0) await new Promise((r) => setTimeout(r, 1100));
    out.push(...(await nominatimInViewbox(q, pt[1], pt[0], 25, perPoint)));
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      path?: unknown;
      corridorKm?: unknown;
      limit?: unknown;
      part?: unknown;
      parts?: unknown;
      /** Skip Overpass and answer from the whole-corridor Nominatim fallback. */
      fallbackOnly?: unknown;
    } | null;

    const raw = Array.isArray(body?.path) ? body.path : [];
    const path: Pt[] = [];
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lng = Number(pair[0]);
      const lat = Number(pair[1]);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      )
        continue;
      path.push([lng, lat]);
      if (path.length >= 6000) break;
    }
    if (path.length < 2) {
      return Response.json({ error: "path with 2+ coordinates required" }, { status: 400 });
    }

    const corridorKm = clamp(Number(body?.corridorKm) || 10, 1, 30);
    const limit = clamp(Number(body?.limit) || 80, 1, 120);
    // Progressive mode: the client asks for one contiguous anchor group per
    // request (`parts` = 4, matching RoutePlanner's STOPS_PARTS) and appends
    // each response as it lands. `parts: 1` keeps the legacy all-at-once
    // behaviour (and its Nominatim fallback). Keep the ceiling aligned with
    // the client: a lower one silently serves the last group twice.
    const parts = clamp(Number(body?.parts) || 1, 1, 4);
    const part = clamp(Number(body?.part) || 0, 0, parts - 1);
    const fallbackOnly = body?.fallbackOnly === true;

    const shape = thinPath(path, MAX_PATH_POINTS);
    const cum = cumulativeKm(shape);
    const totalKm = cum[cum.length - 1] ?? 0;
    const allAnchors = anchors(shape, cum, totalKm, MAX_ANCHORS);
    const points = parts === 1 ? allAnchors : (splitAnchors(allAnchors, parts)[part] ?? []);

    if (points.length === 0) {
      return Response.json({
        places: [],
        totalKm: Math.round(totalKm * 10) / 10,
        corridorKm,
        anchors: allAnchors.length,
        part,
        parts,
        source: "none" satisfies RouteStopsSource,
      });
    }

    // City hints resolve while Overpass is working — at most 6 s, and
    // skipped entirely when the rows already carry `addr:city`. The cheap
    // fallback path skips the reverse-geocode burst: Nominatim rows already
    // carry an address city, and that path is the one used when the app is
    // trying to avoid hammering public services.
    const cityTask: Promise<CityHint[]> = fallbackOnly
      ? Promise.resolve([])
      : withCityHints(points);

    let hits: OsmPoint[] = [];
    let usedFallback = false;
    let primaryFailed = false;

    if (!fallbackOnly) {
      hits = await overpassAlongAnchors({
        anchors: points,
        radiusKm: corridorKm,
        queries: CORRIDOR_QUERIES,
        limit: limit * 3,
        // Bounded (matching the app's other Overpass calls) so the client's
        // one-shot fallback still fits inside its watchdog when public
        // Overpass mirrors are slow.
        timeoutMs: 12_000,
        deadlineMs: 15_000,
        onFailure: () => {
          primaryFailed = true;
        },
      });
    }

    // Mirrors down → a few quiet Nominatim looks spread along the road so the
    // panel still shows something (one category per point; Nominatim asks for
    // ≤1 request/second, hence the spacing). Progressive parts deliberately
    // skip this: three parallel parts would burst Nominatim, and the client
    // makes a single `fallbackOnly` request once every part came back empty.
    if (hits.length === 0 && (fallbackOnly || parts === 1)) {
      hits = await nominatimCorridorFallback(shape, limit);
      usedFallback = true;
    }

    const cityHints = hits.length > 0 ? await cityTask : [];
    const places = toRouteStops(hits, shape, cum, corridorKm, limit, cityHints);
    const source: RouteStopsSource =
      hits.length === 0 ? "none" : usedFallback ? "nominatim" : "overpass";

    return Response.json({
      places,
      totalKm: Math.round(totalKm * 10) / 10,
      corridorKm,
      anchors: allAnchors.length,
      part,
      parts,
      source,
      failed: primaryFailed || (fallbackOnly && hits.length === 0),
    });
  } catch (err) {
    console.error("Route places error:", err);
    return Response.json({ places: [], source: "none", failed: true });
  }
}
