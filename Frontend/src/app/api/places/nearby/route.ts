import { NextRequest } from "next/server";
import { nominatimInViewbox, overpassNearby, type OsmPoint } from "@/lib/osm";
import {
  radiusKmForQuery,
  rankNearbyPlaces,
  type NearbyPlace,
} from "@/lib/nearbyPlaces";

export const runtime = "nodejs";

/**
 * Overpass/Nominatim answer in seconds (a heavy "all restaurants in central
 * Paris" query took ~4.4 s), so the same tab is instant on the second visit:
 * results are cached per location + query for 10 minutes. Older entries are
 * still served while a refresh runs in the background (stale-while-revalidate).
 */
const FRESH_TTL_MS = 10 * 60_000;
const STALE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 200;
/** An empty sweep is retried after 30 s instead of being pinned for 10 min. */
const EMPTY_TTL_MS = 30_000;
/** Whole nearby lookup budget — the details window must never stare at a
 *  skeleton for five seconds. */
const LOOKUP_BUDGET_MS = 3_000;
/** How long Overpass gets before Nominatim's answer is used (Overpass has the
 *  richer tags, but it is also the less reliable of the two). */
const OSM_HEAD_START_MS = 300;

interface CacheEntry {
  at: number;
  places: NearbyPlace[];
}

const cache = new Map<string, CacheEntry>();
/** Keys with a background stale-refresh already running. */
const refreshing = new Set<string>();

function cacheKey(
  la: number,
  lo: number,
  query: string,
  limit: number,
  exclude: string
): string {
  return `${la.toFixed(3)},${lo.toFixed(3)}|${query.toLowerCase()}|${limit}|${exclude.toLowerCase()}`;
}

function remember(key: string, places: NearbyPlace[]): void {
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // Delete-then-set keeps the eviction order least-recently-written first.
  cache.delete(key);
  cache.set(key, { at: Date.now(), places });
}

function readCache(key: string): { places: NearbyPlace[]; fresh: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.at;
  const ttl = entry.places.length > 0 ? FRESH_TTL_MS : EMPTY_TTL_MS;
  if (age < ttl) return { places: entry.places, fresh: true };
  // Empty answers are never kept as stale — the next request must retry.
  if (entry.places.length === 0 || age >= STALE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { places: entry.places, fresh: false };
}

async function buildNearby(
  la: number,
  lo: number,
  query: string,
  limit: number,
  exclude: string
): Promise<NearbyPlace[]> {
  const radiusKm = radiusKmForQuery(query);
  const started = Date.now();
  // Timers must never keep the Node process alive after the response.
  const delay = (ms: number) =>
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    });

  // Both free keyless sources run in parallel: Overpass has the richest tags,
  // Nominatim is the quick, reliable filler. Nominatim's answer is held back
  // briefly so a healthy Overpass gets the first word, and the pair is capped
  // at LOOKUP_BUDGET_MS.
  const osmTask = overpassNearby({
    lat: la,
    lng: lo,
    query,
    radiusKm,
    limit: limit + 4,
    timeoutMs: 3_500,
    deadlineMs: 3_500,
  }).catch(() => [] as OsmPoint[]);
  const poiTask = nominatimInViewbox(
    query,
    la,
    lo,
    radiusKm,
    limit + 4,
    LOOKUP_BUDGET_MS
  ).catch(() => [] as OsmPoint[]);

  const first = await Promise.race([
    osmTask.then((rows) => ({ src: "osm" as const, rows })),
    poiTask.then((rows) =>
      delay(OSM_HEAD_START_MS).then(() => ({ src: "poi" as const, rows }))
    ),
    delay(LOOKUP_BUDGET_MS).then(() => null),
  ]);

  const rows: OsmPoint[] = [];
  if (first) rows.push(...first.rows);
  if (first && rows.length < limit) {
    const other = first.src === "osm" ? poiTask : osmTask;
    // If Overpass failed fast, Nominatim is the only hope — let it use the
    // whole remaining budget. Otherwise give the second source a short grace
    // period: the first list is already usable, and staring at a skeleton for
    // the full 4 s to maybe add a couple of cards is a bad trade.
    const grace =
      first.src === "osm" && rows.length === 0
        ? LOOKUP_BUDGET_MS
        : rows.length === 0
          ? 700
          : 400;
    const left = Math.max(
      300,
      Math.min(grace, LOOKUP_BUDGET_MS - (Date.now() - started))
    );
    const extra = await Promise.race([other, delay(left)]);
    if (extra) rows.push(...extra);
  }

  return rankNearbyPlaces(rows, { lat: la, lng: lo }, limit, exclude);
}

export async function POST(req: NextRequest) {
  try {
    const { lat, lng, q, count, exclude } = await req.json().catch(() => ({}));
    const la = typeof lat === "number" ? lat : parseFloat(String(lat));
    const lo = typeof lng === "number" ? lng : parseFloat(String(lng));
    const query = String(q ?? "restaurants").trim() || "restaurants";
    if (
      !Number.isFinite(la) ||
      !Number.isFinite(lo) ||
      la < -90 ||
      la > 90 ||
      lo < -180 ||
      lo > 180
    ) {
      return Response.json({ error: "lat/lng required" }, { status: 400 });
    }

    const limit = typeof count === "number" ? Math.min(Math.max(count, 1), 12) : 8;
    const excludeName = typeof exclude === "string" ? exclude.trim().slice(0, 140) : "";
    const key = cacheKey(la, lo, query, limit, excludeName);

    const hit = readCache(key);
    if (hit?.fresh) {
      return Response.json({ places: hit.places });
    }
    if (hit) {
      // Stale but usable: answer instantly and refresh in the background.
      if (!refreshing.has(key)) {
        refreshing.add(key);
        void buildNearby(la, lo, query, limit, excludeName)
          .then((places) => remember(key, places))
          .catch(() => {})
          .finally(() => refreshing.delete(key));
      }
      return Response.json({ places: hit.places, stale: true });
    }

    const places = await buildNearby(la, lo, query, limit, excludeName);
    remember(key, places);
    return Response.json({ places });
  } catch (err) {
    console.error("Nearby places error:", err);
    // A 200 with an empty list would read as a genuine "nothing nearby" and
    // hide the retry button; let the client show its error state instead.
    return Response.json({ places: [] }, { status: 500 });
  }
}
