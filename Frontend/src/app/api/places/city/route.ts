import { NextRequest } from "next/server";
import { enforceRateLimit } from "@/server/rateLimit";
import { rememberImage } from "@/server/imageHistory";
import { peekImageById } from "@/server/placeImageIdCache";
import { photoId } from "@/lib/placePhotoProviders";
import { nominatimInViewbox, nominatimInViewboxProbe, overpassQuery, type OsmPoint } from "@/lib/osm";
import {
  buildCityQueries,
  collectCityPlaces,
  countFromPayload,
  isCityCategory,
  rankCityPlaces,
  toLite,
  type CityPlace,
  type CityCategory,
} from "@/lib/cityPlaces";
import { collectNominatimPlaces, NOMINATIM_KEYWORDS } from "@/lib/nominatimPlaces";

export const runtime = "nodejs";

/**
 * City-wide place search for the Explore tabs — a real places source instead
 * of a geocoder's ~10 results.
 *
 * POST { lat, lng, category, page?, limit?, offset? }
 *  → { places: CityPlaceLite[], total, offset, limit, radiusKm, source, hasMore, pending }
 *
 * One Overpass query per category within 25 km of the centre; when the city
 * yields fewer than 20 named results the search widens to 50 km before the
 * list can come back empty. `total` is the exact OSM count (e.g. "1,240
 * hotels in Pune"), while only `limit` ranked places per page ever cross the
 * wire — the server keeps the ranked pool (capped at POOL_CAP) in memory for
 * 24 hours, so the second visit of a city + category is instant. Only
 * successful lookups are cached: when every Overpass mirror fails the route
 * falls back to bounded Nominatim searches so a place always shows results;
 * only when *both* sources fail does it answer an honest, uncached 502 the
 * client can retry — never a cached "0 places" that lies about a city.
 *
 * TWO STAGES, because a city-wide Overpass sweep of a busy mirror can take
 * half a minute — far too long to stare at an empty grid:
 *
 *  1. a NARROW sweep (FAST_RADIUS_KM) answers in a fraction of the time and
 *     is returned straight away, flagged `pending: true`;
 *  2. the full sweep continues in the background and replaces the cached
 *     pool; the client re-asks (cheap: it is a cache hit) and the grid
 *     upgrades to the complete list on its own.
 *
 * The fast stage is what makes the Explore tabs feel immediate; the wide
 * stage keeps the "1,240 hotels in Pune" totals the grid is built around.
 */

const RADII_KM = [25, 50] as const;
/**
 * Radius of the fast first sweep. Overpass cost grows with the scanned
 * area, so a small circle answers in seconds where the city-wide sweep
 * takes tens of seconds.
 */
const FAST_RADIUS_KM = 2;
/**
 * Cap for the fast first screen. The grid renders 40 cards per page, so 60
 * covers the first paint plus one load-more; the wide sweep replaces it.
 */
const FAST_POOL_CAP = 60;
const MIN_RESULTS = 20;
const POOL_CAP = 600;
const CACHE_TTL_MS = 24 * 60 * 60_000;
/** Fallback pools refresh sooner, so Overpass recovery upgrades a city. */
const NOMINATIM_TTL_MS = 6 * 60 * 60_000;
/** A fallback entry older than this gets a background Overpass re-check on hit. */
const REFRESH_MIN_AGE_MS = 10 * 60_000;
/** A pending (fast-only) pool older than this stops asking for the wide one. */
const PENDING_MAX_AGE_MS = 3 * 60_000;
/**
 * How long the request waits for the full sweep once the fast screen came back
 * empty. Mirrors can queue for a minute; the sweep keeps going in the
 * background and the next request picks up its cached result.
 */
const WIDE_WAIT_MS = 6_000;
/** The fast screen's budget: healthy mirrors/Nominatim answer well inside it. */
const FAST_BUDGET_MS = 7_000;
/** Genuinely empty areas are cached briefly, so a source recovery is seen soon. */
const EMPTY_TTL_MS = 10 * 60_000;
const CACHE_MAX = 120;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 60;
/** Nominatim caps a page at 50 — the fallback pool is one keyword page each. */
const NOMINATIM_PAGE = 50;

interface CachedCity {
  at: number;
  places: CityPlace[];
  total: number;
  radiusKm: number;
  source: "overpass" | "nominatim";
  /**
   * True while the full-city pool is still being built in the background —
   * what the client holds is the fast first screen, not the whole list.
   */
  pending?: boolean;
  /**
   * True once the FULL city-wide sweep has replaced this entry. The wide
   * pool must never be overwritten by the fast one that ran before it.
   */
  wide?: boolean;
  /** A real answer with no places (rural coordinates / open water). */
  empty?: boolean;
}

const cache = new Map<string, CachedCity>();
const inflight = new Map<string, Promise<CachedCity>>();
/** Keys currently re-checking Overpass in the background (fallback self-heal). */
const revalidating = new Set<string>();

function isRemarkFailure(data: { elements?: unknown[]; remark?: unknown }): boolean {
  return typeof data.remark === "string" && data.remark.length > 0;
}

/**
 * Bounded Nominatim searches per category keyword — the Overpass-down
 * fallback so every place still gets a real list. Serial with the 1 req/s
 * pacing Nominatim's usage policy asks for.
 *
 * `answered` reports whether *any* keyword request completed: an empty list
 * from a reachable geocoder is a genuine "nothing here", not an outage.
 */
async function nominatimFallback(
  category: CityCategory,
  lat: number,
  lng: number
): Promise<{ places: CityPlace[]; answered: boolean }> {
  const keywords = NOMINATIM_KEYWORDS[category];
  const points: OsmPoint[] = [];
  let answered = false;
  for (let i = 0; i < keywords.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1100));
    const probe = await nominatimInViewboxProbe(
      keywords[i],
      lat,
      lng,
      RADII_KM[0],
      NOMINATIM_PAGE
    );
    if (probe.answered) answered = true;
    points.push(...probe.points);
  }
  return {
    places: rankCityPlaces(collectNominatimPlaces(points, { lat, lng })).slice(0, POOL_CAP),
    answered,
  };
}

/**
 * One Overpass sweep at a radius → ranked pool + total, or null when the
 * mirrors are down. Pool under the cap = we saw everything → the pool IS the
 * exact total; only a capped pool pays for the extra `out count` query.
 */
async function overpassPool(
  category: CityCategory,
  lat: number,
  lng: number,
  radiusKm: number,
  opts?: { cap?: number; timeoutSec?: number; timeoutMs?: number; deadlineMs?: number; withCount?: boolean }
): Promise<{ places: CityPlace[]; total: number } | null> {
  const cap = opts?.cap ?? POOL_CAP;
  const { data, count } = buildCityQueries(
    category,
    { lat, lng, radiusKm },
    cap,
    opts?.timeoutSec ?? 60
  );
  const payload = await overpassQuery(
    data,
    opts?.timeoutMs ?? 55_000,
    opts?.deadlineMs ?? 130_000,
    isRemarkFailure
  );
  if (!payload) return null;
  const elements = payload.elements ?? [];
  const places = rankCityPlaces(collectCityPlaces(elements, { lat, lng }));
  let total = places.length;
  if ((opts?.withCount ?? true) && elements.length >= cap) {
    const countPayload = await overpassQuery(count, 45_000, 100_000, isRemarkFailure);
    total = Math.max(countFromPayload(countPayload), places.length);
  }
  return { places, total };
}

/**
 * The FULL city sweep for a city + category. It starts as soon as the first
 * request for that pair arrives and runs BESIDE the fast sweep, so the
 * complete list is never delayed by the quick first answer. Everyone who
 * asks for the same pair shares this one sweep.
 */
const wideSweeps = new Map<string, Promise<CachedCity | null>>();

function startWideSweep(
  category: CityCategory,
  lat: number,
  lng: number
): Promise<CachedCity | null> {
  const key = `${category}|${lat.toFixed(3)},${lng.toFixed(3)}`;
  const existing = wideSweeps.get(key);
  if (existing) return existing;
  const task = (async (): Promise<CachedCity | null> => {
    for (const radiusKm of RADII_KM) {
      const pool = await overpassPool(category, lat, lng, radiusKm);
      if (!pool) continue;
      if (pool.total >= MIN_RESULTS || radiusKm === RADII_KM[RADII_KM.length - 1]) {
        const entry: CachedCity = {
          at: Date.now(),
          places: pool.places,
          total: pool.total,
          radiusKm,
          source: "overpass",
          wide: true,
          empty: pool.total === 0,
        };
        cache.set(key, entry);
        console.info(
          `[city] ${category} @ ${lat.toFixed(2)},${lng.toFixed(2)} — full pool ready, ` +
            `${pool.total} places`
        );
        return entry;
      }
    }
    return null;
  })().finally(() => wideSweeps.delete(key));
  wideSweeps.set(key, task);
  return task;
}

interface FastPool {
  places: CityPlace[];
  total: number;
  radiusKm: number;
  source: "overpass" | "nominatim";
}

/** First task that resolves non-null within budgetMs; null on timeout. */
async function firstNonNull<T>(tasks: Array<Promise<T | null>>, budgetMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = 0;
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), budgetMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    for (const t of tasks) {
      t.then((v) => {
        settled++;
        if (v) finish(v);
        else if (settled === tasks.length) finish(null);
      }).catch(() => {
        settled++;
        if (settled === tasks.length) finish(null);
      });
    }
  });
}

/** The value when it arrives within budgetMs, otherwise null (task keeps running). */
async function withinBudget<T>(task: Promise<T>, budgetMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, budgetMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    task.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * Bounded Nominatim first screen: one or two keyword viewbox searches around
 * the centre under a short deadline. Nominatim answers in ~1 s where a
 * congested Overpass mirror queues for twenty — racing the two is what
 * guarantees the grid paints almost immediately even when every Overpass
 * instance is busy.
 */
async function nominatimFast(
  category: CityCategory,
  lat: number,
  lng: number
): Promise<FastPool | null> {
  const keywords = NOMINATIM_KEYWORDS[category];
  const points: OsmPoint[] = [];
  const deadline = Date.now() + 7_000;
  for (let i = 0; i < keywords.length && i < 2; i++) {
    if (i > 0) {
      // Nominatim's usage policy asks for 1 req/s — pace the second keyword.
      if (deadline - Date.now() < 1_500) break;
      await new Promise((r) => setTimeout(r, 1_100));
    }
    if (Date.now() > deadline) break;
    points.push(...(await nominatimInViewbox(keywords[i], lat, lng, 10, 50, 6_000)));
    if (points.length >= MIN_RESULTS) break;
  }
  const places = rankCityPlaces(collectNominatimPlaces(points, { lat, lng })).slice(0, FAST_POOL_CAP);
  if (places.length === 0) return null;
  return { places, total: places.length, radiusKm: 10, source: "nominatim" };
}

async function queryCity(category: CityCategory, lat: number, lng: number): Promise<CachedCity> {
  const started = Date.now();

  // The full city sweep starts NOW and runs beside the fast one — the grid
  // ends up with its complete list at the same time it always did, and the
  // fast first screen arrives in the meantime.
  const widePromise = startWideSweep(category, lat, lng);

  // STAGE 1 — the fast first screen: race a cheap Overpass circle (small
  // radius, small cap, short budget) against a bounded Nominatim keyword
  // search; whichever answers first WITH results paints the grid in seconds.
  let overpassDown = false;
  const fastOverpass: Promise<FastPool | null> = overpassPool(category, lat, lng, FAST_RADIUS_KM, {
    cap: FAST_POOL_CAP,
    timeoutSec: 20,
    timeoutMs: 20_000,
    deadlineMs: 25_000,
    withCount: false,
  }).then((p) => {
    // null = every mirror failed / circuit open. A successful-but-empty pool
    // is different: that means the area really has nothing.
    if (!p) overpassDown = true;
    return p && p.places.length > 0
      ? { places: p.places, total: p.places.length, radiusKm: FAST_RADIUS_KM, source: "overpass" as const }
      : null;
  });
  const fast = await firstNonNull([fastOverpass, nominatimFast(category, lat, lng)], FAST_BUDGET_MS);
  if (fast) {
    console.info(
      `[city] ${category} @ ${lat.toFixed(2)},${lng.toFixed(2)} — ` +
        `${fast.places.length} fast places via ${fast.source} in ${Date.now() - started} ms (full pool continues)`
    );
    return {
      at: Date.now(),
      places: fast.places,
      total: fast.total,
      radiusKm: fast.radiusKm,
      source: fast.source,
      pending: true,
    };
  }

  // STAGE 2 — no fast answer: the full sweep (already running) is the one.
  // Bounded: a mirror queue must not hold the request open for a minute. If
  // the sweep outlives the budget it keeps running and caches its result, so
  // the next request (or the client's retry) is instant.
  //
  // When the fast Overpass attempt already failed on every mirror, waiting
  // for the wide sweep just re-runs the same dead mirrors — skip straight to
  // the geocoder fallback and let the sweep finish in the background.
  const wide = overpassDown ? null : await withinBudget(widePromise, WIDE_WAIT_MS);
  if (wide) {
    console.info(
      `[city] ${category} @ ${lat.toFixed(2)},${lng.toFixed(2)} r=${wide.radiusKm}km — ` +
        `${wide.total} total in ${Date.now() - started} ms`
    );
    return wide;
  }

  // STAGE 3 — the free fallback, so a place always gets a real list.
  console.warn(
    `[city] ${category} @ ${lat.toFixed(2)},${lng.toFixed(2)} — all Overpass mirrors failed, trying Nominatim`
  );
  const fallback = await nominatimFallback(category, lat, lng);
  if (fallback.places.length > 0) {
    console.info(
      `[city] ${category} @ ${lat.toFixed(2)},${lng.toFixed(2)} — Nominatim fallback, ` +
        `${fallback.places.length} places in ${Date.now() - started} ms`
    );
    return {
      at: Date.now(),
      places: fallback.places,
      total: fallback.places.length,
      radiusKm: RADII_KM[0],
      source: "nominatim",
    };
  }
  // Nominatim ANSWERED with nothing: this really is an empty area (a country
  // centroid in the wilderness, open water, a rural coordinate). That is not
  // an outage — an honest, short-lived empty answer beats a 502 that blames
  // the source and hides the truth from the user.
  if (fallback.answered) {
    console.info(
      `[city] ${category} @ ${lat.toFixed(2)},${lng.toFixed(2)} — genuinely empty area ` +
        `(${Date.now() - started} ms)`
    );
    return {
      at: Date.now(),
      places: [],
      total: 0,
      radiusKm: RADII_KM[0],
      source: "nominatim",
      empty: true,
    };
  }
  throw new Error("places source unavailable");
}

/**
 * Fire-and-forget Overpass re-check for a Nominatim fallback entry, so the
 * next visitor of a recovered city gets the full pool without waiting.
 */
function revalidateCity(key: string, category: CityCategory, lat: number, lng: number): void {
  if (revalidating.has(key) || inflight.has(key)) return;
  revalidating.add(key);
  overpassPool(category, lat, lng, RADII_KM[0])
    .then((pool) => {
      if (pool && pool.places.length > 0) {
        cache.set(key, {
          at: Date.now(),
          places: pool.places,
          total: pool.total,
          radiusKm: RADII_KM[0],
          source: "overpass",
          wide: true,
        });
        console.info(`[city] ${key} — Overpass recovered, ${pool.total} total (was fallback)`);
      }
    })
    .catch(() => {})
    .finally(() => revalidating.delete(key));
}

function loadCity(category: CityCategory, lat: number, lng: number): Promise<CachedCity> {
  const key = `${category}|${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = cache.get(key);
  // Empty answers expire quickly; Nominatim-sourced pools sooner than Overpass
  // ones so a recovery upgrades them; the full pool lives for a day.
  const ttl = hit?.empty
    ? EMPTY_TTL_MS
    : hit?.source === "nominatim"
      ? NOMINATIM_TTL_MS
      : CACHE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) {
    if (hit.source === "nominatim" && !hit.empty && Date.now() - hit.at > REFRESH_MIN_AGE_MS) {
      revalidateCity(key, category, lat, lng);
    }
    // The wide pool never landed (mirrors died, or the process restarted
    // mid-sweep) — stop telling the client to keep asking for it.
    if (hit.pending && Date.now() - hit.at > PENDING_MAX_AGE_MS) {
      const settled: CachedCity = { ...hit, pending: false };
      cache.set(key, settled);
      return Promise.resolve(settled);
    }
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  // Failures propagate (nothing is cached): the client shows a retry, and the
  // next request hits the mirrors again instead of serving a cached "0".
  const task = queryCity(category, lat, lng)
    .then((result) => {
      // The wide pool may have landed while the fast sweep was still in
      // flight — never let the fast answer overwrite the complete one.
      const existing = cache.get(key);
      if (!existing?.wide) {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, result);
      }
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, { scope: "places-city", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const lat = typeof body.lat === "number" ? body.lat : Number.NaN;
    const lng = typeof body.lng === "number" ? body.lng : Number.NaN;
    const category = String(body.category ?? "");
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return Response.json({ error: "lat/lng required" }, { status: 400 });
    }
    if (!isCityCategory(category)) {
      return Response.json({ error: "unknown category" }, { status: 400 });
    }

    const limitRaw = typeof body.limit === "number" ? Math.floor(body.limit) : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(limitRaw, 1), MAX_LIMIT);
    const pageRaw = typeof body.page === "number" ? Math.floor(body.page) : 1;
    const page = Math.max(pageRaw, 1);
    const offsetRaw =
      typeof body.offset === "number" && body.offset >= 0
        ? Math.floor(body.offset)
        : (page - 1) * limit;
    const offset = Math.min(offsetRaw, MAX_LIMIT * 100);

    const result = await loadCity(category, lat, lng);
    // Images already resolved for these places (7-day memo) ride along, so a
    // revisit renders its photos on the very first paint — no round trip.
    // Two cards must never show the same photo: the first one keeps the known
    // image, later ones fall through to the normal lookup, which walks its
    // providers past everything served recently (peeked images included).
    const takenOnPage = new Set<string>();
    const places = result.places.slice(offset, offset + limit).map((place) => {
      const lite = toLite(place);
      const imageUrl = peekImageById(place.id);
      const id = imageUrl ? photoId(imageUrl) : "";
      if (!imageUrl || !id || takenOnPage.has(id)) return lite;
      takenOnPage.add(id);
      rememberImage(imageUrl);
      return { ...lite, imageUrl };
    });
    return Response.json({
      places,
      total: result.total,
      offset,
      limit,
      radiusKm: result.radiusKm,
      // "overpass" = the full city pool; "nominatim" = degraded-mode fallback.
      source: result.source,
      // True while the full city-wide pool is still being built behind the
      // fast first screen — the client re-asks to pick up the complete list.
      pending: result.pending === true,
      // A real, reachable answer with no places (rural centre / open water).
      // The UI shows an empty state, not a "source unavailable" error.
      empty: result.places.length === 0,
      // Load-more continues while the ranked pool has more to hand out; the
      // pool is capped (POOL_CAP), so "1,240 total" can still stop at 600.
      hasMore: offset + places.length < result.places.length,
    });
  } catch (err) {
    console.error("City places error:", err);
    // Mirrors down / at capacity: an honest, uncached 502 the client can
    // retry — never a cached "0 places" that lingers for 24 hours.
    return Response.json(
      {
        error: "Places source is unavailable right now — try again in a minute.",
        places: [],
        total: 0,
        offset: 0,
        limit: DEFAULT_LIMIT,
        hasMore: false,
      },
      { status: 502 }
    );
  }
}
