/**
 * Free, keyless place data from OpenStreetMap (Overpass) + Nominatim.
 * Used as the primary place source whenever a paid provider is missing or empty.
 */

import { runWithProvider } from "@/server/http";

export interface OsmPoint {
  name: string;
  lat: number;
  lng: number;
  category?: string;
  address?: string;
  /** `addr:city` tag when present — sharpens image lookups without a geocode. */
  city?: string;
  openingHours?: string;
  website?: string;
  phone?: string;
  /** Nominatim identity, e.g. "node"/1324775026 — reuses the Overpass wire ids. */
  osmType?: string;
  osmId?: number;
  /** Wikidata entity (Q…) tagged on the place — exact P18 photo. */
  wikidata?: string;
  /** OSM `wikipedia` tag ("en:Lal Mahal") — the exact article for photos. */
  wikipedia?: string;
  /** OSM `image`/`wikimedia_commons` tag — a known Commons photo. */
  imageTag?: string;
  /** Nominatim's rough significance (0..1) — a ranking hint, not a rating. */
  importance?: number;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

const OVERPASS_ENDPOINTS = [
  // Global mirrors. Overpass rejects anonymous requests with HTTP 406, so a
  // descriptive User-Agent is required (see overpassQuery below). Dead ones
  // fail fast and cost nothing — the hedge moves on to the next.
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.rambler.ru/cgi/interpreter",
];
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
/**
 * How long a mirror may stay quiet before the NEXT one is asked as well.
 * Short enough that a congested instance costs a couple of seconds instead of
 * a minute, long enough that a healthy instance is never doubled up on.
 */
const MIRROR_HEDGE_MS = 2_000;
/** OSM projects reject anonymous clients (HTTP 406 / "Access denied"). */
export const OSM_USER_AGENT = "AITravelPlanner/1.0 (free OpenStreetMap place data)";
const OSM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "User-Agent": OSM_USER_AGENT,
} as const;

/**
 * Runs an Overpass QL query, trying known mirrors in order (overpass-api.de
 * sometimes rejects requests that omit a User-Agent). Returns parsed JSON
 * or null when every mirror fails.
 *
 * Runs under the shared "overpass" circuit breaker: once a mirror sweep fails
 * `BREAKER_FAILURE_THRESHOLD` times in a row, further calls fail fast until
 * the cooldown passes, so callers fall back to Nominatim instead of waiting.
 *
 * `deadlineMs` caps the whole sweep — RAG passes a short one so a dead
 * mirror stack can't eat the chat's retrieval budget.
 */
/**
 * One mirror, one query. A 429 (the public instances throttle bursts) gets
 * one short backoff and a second try; anything else loses the race so the
 * next mirror can take over immediately.
 */
async function askMirror(
  endpoint: string,
  query: string,
  timeoutMs: number,
  deadline: number,
  signal: AbortSignal,
  isFailure?: (data: { elements?: unknown[]; remark?: unknown }) => boolean
): Promise<{ elements?: unknown[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: OSM_HEADERS,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (res.status === 429 && attempt === 0 && Date.now() + 2500 < deadline) {
        // Shared public mirrors throttle bursts — back off and try once more.
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (data && typeof data === "object") {
        const parsed = data as { elements?: unknown[]; remark?: unknown };
        if (isFailure?.(parsed)) throw new Error("bad payload");
        return parsed;
      }
      throw new Error("bad payload");
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt === 0 && Date.now() + 2500 < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      throw err;
    }
  }
  throw new Error("mirror failed");
}

/**
 * Asks the public Overpass instances, HEDGED.
 *
 * The instances are wildly uneven: one can be queueing for a minute while
 * another answers in two seconds. Asking them one after another meant the
 * first (congested) mirror ate the whole budget — 55 s — before the next one
 * was even tried, and the user stared at skeletons for all of it.
 *
 * So the first mirror is asked immediately and the next ones join in after a
 * short delay if it stays quiet. The mirrors are independent instances, so
 * this never multiplies the load on any single one: at most one request per
 * mirror per sweep. The first usable answer wins and the rest are aborted.
 */
function sweepMirrors(
  query: string,
  timeoutMs: number,
  deadline: number,
  isFailure?: (data: { elements?: unknown[]; remark?: unknown }) => boolean
): Promise<{ elements?: unknown[] }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false;
    let next = 0;
    /** Mirrors still answering. */
    let inFlight = 0;
    let hedge: NodeJS.Timeout | null = null;

    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      if (hedge) clearTimeout(hedge);
      controller.abort();
      settle();
    };

    /**
     * Give up only when EVERY mirror has been tried and none is still
     * answering — a fast failure of the hedged mirrors must never cancel the
     * slow first one that is about to deliver.
     */
    const giveUp = () => {
      if (done) return;
      if (next >= OVERPASS_ENDPOINTS.length && inFlight === 0) {
        finish(() => reject(new Error("all Overpass mirrors failed")));
      }
    };

    const startNext = () => {
      if (done) return;
      if (hedge) {
        clearTimeout(hedge);
        hedge = null;
      }
      if (next >= OVERPASS_ENDPOINTS.length) {
        giveUp();
        return;
      }
      const endpoint = OVERPASS_ENDPOINTS[next++];
      const left = deadline - Date.now();
      if (left < 1000) {
        giveUp();
        return;
      }
      inFlight++;
      askMirror(
        endpoint,
        query,
        Math.min(timeoutMs, left),
        deadline,
        controller.signal,
        isFailure
      ).then(
        (data) => finish(() => resolve(data)),
        () => {
          inFlight--;
          // This mirror is out — bring the next one in right away.
          if (!done) startNext();
          else giveUp();
        }
      );
      // Hedge: the next mirror joins in if this one stays quiet.
      if (next < OVERPASS_ENDPOINTS.length) {
        hedge = setTimeout(() => {
          if (!done) startNext();
        }, MIRROR_HEDGE_MS);
        hedge.unref?.();
      }
    };

    startNext();
  });
}

export async function overpassQuery(
  query: string,
  // The public mirrors are uneven: a sweep of a busy city can take 40 s on a
  // congested instance while another answers in two. The old 10 s budget
  // simply gave up on the slow ones, and since these sweeps are now the ONLY
  // source of places and hotels, "gave up" meant an empty list. The mirrors
  // are hedged (see sweepMirrors), so the extra budget costs nothing when a
  // healthy instance answers quickly. Latency-sensitive callers (the RAG,
  // the nearby search) pass their own, shorter budgets.
  timeoutMs = 25_000,
  deadlineMs = 40_000,
  /**
   * A mirror may answer HTTP 200 with a payload that reports its own runtime
   * error — an Overpass query timeout looks exactly like a success here.
   * Returning true marks the response as a miss, so the sweep moves to the
   * next mirror instead of handing an empty result back as if it were data.
   */
  isFailure?: (data: { elements?: unknown[]; remark?: unknown }) => boolean
): Promise<{ elements?: unknown[] } | null> {
  try {
    return await runWithProvider(
      "overpass",
      async () => {
        const deadline = Date.now() + deadlineMs;
        return sweepMirrors(query, timeoutMs, deadline, isFailure);
      },
      // The route planner asks for four corridor segments at once and the
      // city endpoint runs a fast sweep beside a full one — six in flight is
      // the ceiling, so a segment never queues behind another.
      6
    );
  } catch {
    return null; // circuit open / queue timeout / all mirrors failed
  }
}

/** Nominatim only understands short category keywords, not phrases. */
function poiQueryFor(query: string): string {
  const q = query.toLowerCase().trim();
  if (/landmark|monument|historic|heritage|castle|memorial|ruin/.test(q)) return "monument";
  if (/museum|gallery|art\b|exhibition/.test(q)) return "museum";
  if (/things to do|activity|activities|attraction|sight|tour\b/.test(q)) return "attractions";
  if (/cafe|coffee|tea house/.test(q)) return "cafe";
  if (/bar|pub|nightlife|cocktail/.test(q)) return "bar";
  // Shopping before the generic food branch: "street food markets" should
  // search markets, not every restaurant in town.
  if (/street food|market/.test(q)) return "market";
  // Only rewrite the broad category. Free text such as "gift shop",
  // "bookshop" or "department store" is more precise left untouched.
  if (/^(shopping|shops?|malls?|stores?|shopping (malls?|centres?|centers?))$/.test(q)) {
    return "mall";
  }
  // Only broad categories are rewritten. Specific cuisines ("pizza", "sushi",
  // "bakery") stay as free text so Nominatim can return the exact kind of
  // place instead of a generic restaurant list.
  if (/restaurant|dining|food|eat|meal|cuisine/.test(q)) return "restaurant";
  if (/hotel|stay|lodging|hostel|resort/.test(q)) return "hotel";
  if (/park|garden|nature/.test(q)) return "park";
  if (/viewpoint|lookout|panorama/.test(q)) return "viewpoint";
  return query;
}

/** First string value among `keys` in a loosely-typed object. */
function pickString(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** One Nominatim search row → OsmPoint (null when unusable). */
function fromNominatimRow(item: unknown): OsmPoint | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const lat = parseFloat(String(r.lat ?? ""));
  const lng = parseFloat(String(r.lon ?? ""));
  // POI searches also return unnamed features whose "name" is just their
  // street address. Those make terrible cards ("Station Road, Barodia
  // Scheme, …" as a restaurant title), so require a real name.
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) return null;
  const osmId = typeof r.osm_id === "number" ? r.osm_id : undefined;
  const importance = typeof r.importance === "number" ? r.importance : undefined;
  // `extratags=1` and `addressdetails=1` carry the same photo identity the
  // Overpass path receives (image / wikidata / wikipedia), plus a usable city
  // for card image lookups. Without them a Nominatim-only card had no photo
  // hints at all and fell back to a slow, fuzzy keyword search.
  const extratags =
    r.extratags && typeof r.extratags === "object"
      ? (r.extratags as Record<string, unknown>)
      : undefined;
  const address =
    r.address && typeof r.address === "object" ? (r.address as Record<string, unknown>) : undefined;
  const wikidata = pickString(extratags, "wikidata");
  return {
    name: name.slice(0, 140),
    lat,
    lng,
    category: typeof r.type === "string" ? r.type.replace(/_/g, " ") : undefined,
    address: typeof r.display_name === "string" ? r.display_name.slice(0, 160) : undefined,
    city: pickString(address, "city", "town", "village", "municipality", "county"),
    openingHours: pickString(extratags, "opening_hours"),
    website: pickString(extratags, "website", "contact:website") ?? pickString(r, "website"),
    phone: pickString(extratags, "phone", "contact:phone"),
    osmType: typeof r.osm_type === "string" ? r.osm_type : undefined,
    osmId,
    importance,
    wikidata: wikidata && /^Q\d+$/.test(wikidata) ? wikidata : undefined,
    wikipedia: pickString(extratags, "wikipedia"),
    imageTag: pickString(extratags, "image", "wikimedia_commons"),
  };
}

/** Category search inside a bounding box (free Nominatim fallback for Overpass). */
export interface NominatimProbe {
  points: OsmPoint[];
  /**
   * True when Nominatim actually answered (even with zero rows). Distinguishes
   * "there is nothing here" from "the geocoder is unreachable" so the caller
   * can show an honest empty state instead of a hard error.
   */
  answered: boolean;
}

export async function nominatimInViewboxProbe(
  query: string,
  lat: number,
  lng: number,
  radiusKm = 3,
  limit = 12,
  timeoutMs = 8000
): Promise<NominatimProbe> {
  const q = poiQueryFor(query).trim();
  if (!q || !Number.isFinite(lat) || !Number.isFinite(lng)) return { points: [], answered: false };
  const d = Math.min(Math.max(radiusKm, 0.5), 25) / 111;
  const viewbox = `${lng - d},${lat + d},${lng + d},${lat - d}`;
  try {
    return await runWithProvider("nominatim", async () => {
      const url = new URL(NOMINATIM_ENDPOINT);
      url.searchParams.set("format", "json");
      url.searchParams.set("q", q);
      url.searchParams.set("viewbox", viewbox);
      url.searchParams.set("bounded", "1");
      url.searchParams.set("limit", String(limit));
      // Photo identity + city + hours for the cards (see fromNominatimRow).
      url.searchParams.set("extratags", "1");
      url.searchParams.set("addressdetails", "1");
      // The UI is English; without this a Moscow sweep returns Cyrillic names
      // next to English headings. Nominatim falls back to the local name when
      // no English one exists, so nothing is lost.
      url.searchParams.set("accept-language", "en");
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": OSM_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("nominatim malformed response");
      const out: OsmPoint[] = [];
      for (const item of data) {
        const point = fromNominatimRow(item);
        if (point) out.push(point);
        if (out.length >= limit) break;
      }
      return { points: out, answered: true };
    });
  } catch {
    return { points: [], answered: false };
  }
}

export async function nominatimInViewbox(
  query: string,
  lat: number,
  lng: number,
  radiusKm = 3,
  limit = 12,
  timeoutMs = 8000
): Promise<OsmPoint[]> {
  const probe = await nominatimInViewboxProbe(query, lat, lng, radiusKm, limit, timeoutMs);
  return probe.points;
}

/**
 * Free-text Nominatim POI lookup — last resort when Overpass is down.
 *
 * With a `center` the lookup is scoped to that area: a bare "hotels in Rome"
 * is ambiguous, and Nominatim answers with the hotels of Rome, Georgia. The
 * viewbox search keeps the rows in the city the caller actually means.
 */
export async function nominatimPois(
  query: string,
  limit = 10,
  center?: { lat: number; lng: number }
): Promise<OsmPoint[]> {
  const q = query.trim();
  if (!q) return [];
  if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
    return nominatimInViewbox(q, center.lat, center.lng, 8, limit);
  }
  try {
    const res = await fetch(
      `${NOMINATIM_ENDPOINT}?format=json&limit=${limit}&q=${encodeURIComponent(q)}`,
      {
        headers: { Accept: "application/json", "User-Agent": OSM_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    const out: OsmPoint[] = [];
    for (const item of data) {
      const point = fromNominatimRow(item);
      if (point) out.push(point);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Maps a human query ("restaurants", "cafes", "tourist attractions"…) to an OSM tag filter. */
function filterFor(query: string): string {
  const q = query.toLowerCase();
  // "coffee shop" and "bakery shop" contain "shop" but are food, not retail.
  if (/cafe|coffee|tea house/.test(q)) return `"amenity"~"cafe|ice_cream"`;
  if (/bakery|patisserie|pastry/.test(q)) return `"shop"~"bakery|pastry"`;
  if (/shop|shopping|mall|store|market/.test(q)) {
    return `"shop"~"mall|clothes|gift|department_store|shoes|jewelry|electronics|books|supermarket"`;
  }
  if (/bar|pub|drink|nightlife|cocktail/.test(q))
    return `"amenity"~"bar|pub|biergarten|cocktail_bar"`;
  if (
    /restaurant|dining|food|eat|meal|cuisine|pizza|sushi|burger|biryani|ramen|noodle|taco|kebab|shawarma|bakery|breakfast|brunch|dessert|vegan|vegetarian|halal|kosher/.test(
      q
    )
  ) {
    return `"amenity"~"restaurant|fast_food"`;
  }
  if (/hotel|stay|lodging|accommodation|hostel|resort/.test(q)) {
    return `"tourism"~"hotel|guest_house|hostel|motel|resort"`;
  }
  if (/museum|gallery|art\b|exhibition/.test(q)) return `"tourism"~"museum|gallery|artwork"`;
  if (/landmark|monument|historic|heritage|castle|ruin|memorial|archaeolog/.test(q)) {
    return `"historic"~"monument|memorial|castle|ruins|archaeological_site|attraction"`;
  }
  if (
    /things to do|thing to do|activity|activities|entertainment|adventure|fun day|family/.test(q)
  ) {
    return `"tourism"~"attraction|theme_park|zoo|aquarium|viewpoint"`;
  }
  return `"tourism"~"attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park"`;
}

function categoryOf(tags: Record<string, string>): string {
  const raw =
    tags["tourism"] ||
    tags["historic"] ||
    tags["amenity"] ||
    tags["shop"] ||
    tags["leisure"] ||
    "place";
  return raw.replace(/_/g, " ");
}

function addressOf(tags: Record<string, string>): string | undefined {
  const joined = [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]]
    .filter(Boolean)
    .join(" ");
  return joined || undefined;
}

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Overpass elements → named points, de-duplicated by name + coordinates. */
function collectOverpassPoints(elements: OverpassElement[], collectMax: number): OsmPoint[] {
  const out: OsmPoint[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const tags = el.tags;
    if (typeof lat !== "number" || typeof lng !== "number" || !tags) continue;
    const name = tags["name"];
    if (!name) continue;
    const key = `${name}|${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const wikidata = tags["wikidata"]?.trim() ?? "";
    out.push({
      name: name.slice(0, 140),
      lat,
      lng,
      category: categoryOf(tags),
      address: addressOf(tags),
      city: tags["addr:city"]?.trim() || undefined,
      openingHours: tags["opening_hours"],
      website: tags["website"] || tags["contact:website"],
      phone: tags["phone"] || tags["contact:phone"],
      // Keep the OSM identity: a stable place id enables the 7-day image cache
      // and lets the same stop dedupe across progressive route requests.
      osmType: el.type,
      osmId: typeof el.id === "number" ? el.id : undefined,
      // Exact photo hints: a tagged Commons file or Wikidata entity lets the
      // card paint its real photo immediately instead of searching for one.
      wikidata: /^Q\d+$/.test(wikidata) ? wikidata : undefined,
      wikipedia: tags["wikipedia"]?.trim() || undefined,
      imageTag: tags["image"] || tags["wikimedia_commons"] || undefined,
    });
    if (out.length >= collectMax) break;
  }
  return out;
}

/**
 * Folds tag conditions sharing a key into one OR regex, so unioning several
 * categories costs a single clause per key: `"tourism"~"hotel"` +
 * `"tourism"~"museum"` → `"tourism"~"hotel|museum"`. Anything that isn't a
 * plain `"key"~"value"` condition passes through untouched.
 */
function mergeTagFilters(filters: string[]): string[] {
  const byKey = new Map<string, Set<string>>();
  const passthrough: string[] = [];
  for (const f of [...new Set(filters)]) {
    const m = /^"([^"]+)"~"([^"]*)"$/.exec(f);
    if (!m) {
      passthrough.push(f);
      continue;
    }
    const values = byKey.get(m[1]) ?? new Set<string>();
    for (const v of m[2].split("|")) if (v) values.add(v);
    byKey.set(m[1], values);
  }
  const merged = [...byKey.entries()].map(([key, values]) => `"${key}"~"${[...values].join("|")}"`);
  return [...merged, ...passthrough];
}

/** Search OSM around a coordinate. Returns [] on any failure/timeout. */
export async function overpassNearby(opts: {
  lat: number;
  lng: number;
  query?: string;
  radiusKm?: number;
  limit?: number;
  /** Per-mirror fetch timeout (default 10s). */
  timeoutMs?: number;
  /** Whole-mirror-sweep deadline (default 22s). RAG passes a short one. */
  deadlineMs?: number;
}): Promise<OsmPoint[]> {
  if (!Number.isFinite(opts.lat) || !Number.isFinite(opts.lng)) return [];
  const radius = Math.round(Math.min(Math.max(opts.radiusKm ?? 3, 0.2), 30) * 1000);
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
  const f = filterFor(opts.query ?? "");
  const query =
    `[out:json][timeout:10];` +
    `( node[${f}](around:${radius},${opts.lat},${opts.lng});` +
    ` way[${f}](around:${radius},${opts.lat},${opts.lng}); );` +
    `out center body ${limit * 4};`;

  try {
    const data = await overpassQuery(query, opts.timeoutMs, opts.deadlineMs);
    if (!data) return [];
    const elements = Array.isArray(data.elements) ? (data.elements as OverpassElement[]) : [];

    const out = collectOverpassPoints(elements, Math.min(limit * 4, 60));
    // Nearest first — Overpass returns rows in no useful order.
    out.sort((a, b) => haversineKm(opts, a) - haversineKm(opts, b));
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * One Overpass sweep across every anchor point along a path — this is what
 * answers "what's between my origin and destination?" without firing a query
 * per stop. All `queries` are unioned into a single request (tag conditions
 * that share a key are folded together first), so the whole corridor costs
 * one round trip to one mirror.
 *
 * Returns points sorted nearest-anchor first; the caller decides what
 * "along the route" ordering means for its own geometry.
 */
export async function overpassAlongAnchors(opts: {
  /** Sample points spread along the route (capped at 6). */
  anchors: Array<{ lat: number; lng: number }>;
  /** Search corridor around each anchor, in km (capped at 30). */
  radiusKm?: number;
  /** Human categories ("hotel", "restaurants", "cafes"…). */
  queries: string[];
  limit?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  /** Called when every mirror failed (as opposed to a genuinely empty area). */
  onFailure?: () => void;
}): Promise<OsmPoint[]> {
  const anchors = opts.anchors
    .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lng))
    .slice(0, 6);
  if (anchors.length === 0) return [];

  const radius = Math.round(Math.min(Math.max(opts.radiusKm ?? 5, 0.2), 30) * 1000);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const filters = mergeTagFilters(opts.queries.map(filterFor));
  if (filters.length === 0) return [];

  // `nwr` folds node + way + relation into ONE clause. The public instances
  // are slow enough that halving the union size is often the difference
  // between a corridor query finishing and hitting Overpass's own timeout —
  // which, note, arrives as HTTP 200 with a `remark`, not as an error.
  const clauses: string[] = [];
  for (const a of anchors) {
    for (const f of filters) {
      clauses.push(` nwr[${f}](around:${radius},${a.lat},${a.lng});`);
    }
  }
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const deadlineMs = opts.deadlineMs ?? 32_000;
  const query =
    `[out:json][timeout:${Math.max(5, Math.round(timeoutMs / 1000))}];` +
    `(${clauses.join("")});out center body ${limit * 3};`;

  try {
    const data = await overpassQuery(
      query,
      timeoutMs,
      deadlineMs,
      (d) =>
        // Empty + remark = the query died. Rows present = usable data even if
        // the response was truncated, so never throw those away.
        typeof d.remark === "string" && (d.elements?.length ?? 0) === 0
    );
    if (!data) {
      opts.onFailure?.();
      return [];
    }
    const elements = Array.isArray(data.elements) ? (data.elements as OverpassElement[]) : [];
    const out = collectOverpassPoints(elements, limit * 3);
    const nearest = new Map<OsmPoint, number>();
    for (const p of out) {
      let best = Infinity;
      for (const a of anchors) best = Math.min(best, haversineKm(a, p));
      nearest.set(p, best);
    }
    out.sort((a, b) => (nearest.get(a) ?? 0) - (nearest.get(b) ?? 0));
    return out.slice(0, limit);
  } catch {
    opts.onFailure?.();
    return [];
  }
}

/** Free geocode (Nominatim) → map center, or null. */
export async function geocodeCenter(query: string): Promise<{ lat: number; lng: number } | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    return await runWithProvider("nominatim", async () => {
      const res = await fetch(
        `${NOMINATIM_ENDPOINT}?format=json&limit=1&q=${encodeURIComponent(q)}`,
        {
          headers: { Accept: "application/json", "User-Agent": OSM_USER_AGENT },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
      const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
      if (!Array.isArray(data) || data.length === 0) return null;
      const lat = parseFloat(String(data[0]?.lat ?? ""));
      const lng = parseFloat(String(data[0]?.lon ?? ""));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    });
  } catch {
    return null;
  }
}
