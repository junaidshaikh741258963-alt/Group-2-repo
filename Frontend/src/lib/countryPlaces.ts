/**
 * Country → destination cities, from real Wikidata data.
 *
 * A country is not a city: its geocoded centre is usually wilderness (Russia's
 * centroid sits in Siberia), so a 2–50 km POI sweep around it can only come
 * back empty. When the user picks a country we show its actual destinations
 * instead — the populated cities people travel to — and a click on one drills
 * into the normal city experience.
 *
 * Source: the QLever Wikidata endpoint. It serves the same graph as
 * query.wikidata.org but answers this query in 1.5–6 s instead of timing out
 * past 30 s, and it needs no key. Only `?city ?pop ?coord` travels over the
 * wire; labels come from the MediaWiki entity API, which is fast and batched.
 *
 * Results are cached in-process for a day: the set of a country's biggest
 * cities does not change between two Explore visits.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { haversineKm } from "./osm";

export interface CountryDestination {
  /** Wikidata Q-id — also the exact-photo identity for the image resolver. */
  id: string;
  name: string;
  lat: number;
  lng: number;
  population?: number;
}

export interface CountryDestinations {
  countryCode: string;
  places: CountryDestination[];
  source: "wikidata";
}

const QLEVER_ENDPOINT = "https://qlever.cs.uni-freiburg.de/api/wikidata";
/** Official endpoint — slow, but the fallback when QLever throttles or fails. */
const WDQS_ENDPOINT = "https://query.wikidata.org/sparql";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "AITravelPlanner/1.0 (country destination discovery)";

/**
 * Population floors, tried in order until a country yields enough cities.
 * The first rung is what large countries pay for; small countries (Iceland,
 * Malta…) fall to a lower floor instead of showing one capital and a gap.
 */
const MIN_POP_LADDER = [100_000, 20_000, 5_000] as const;
/** Below this a country list looks broken, so the next rung is tried. */
const ENOUGH_CITIES = 8;
/** Rows fetched; the closest-metro duplicates are dropped before labelling. */
const QUERY_LIMIT = 48;
const RESULT_LIMIT = 24;
/** Two entities closer than this are the same place (city vs. metro area). */
const SAME_PLACE_KM = 8;
const QUERY_TIMEOUT_MS = 9_000;
const WDQS_TIMEOUT_MS = 25_000;
const LABEL_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX = 200;
/** The public QLever sits behind an nginx burst limit; space queries out. */
const MIN_QUERY_GAP_MS = 800;

interface CacheEntry {
  /** Bumped whenever the result shape/filters change, so old files are ignored. */
  v?: number;
  at: number;
  value: CountryDestinations;
}

/** Bump when the query/filter semantics change: stale disk entries are dropped. */
const DATA_VERSION = 2;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CountryDestinations>>();

interface SparqlRow {
  city?: { value?: string };
  pop?: { value?: string };
  coord?: { value?: string };
}

const PREFIXES = [
  "PREFIX wdt: <http://www.wikidata.org/prop/direct/>",
  "PREFIX wd: <http://www.wikidata.org/entity/>",
].join("\n");

/**
 * One population rung. The UNION covers both the strict "city" class and
 * "big city" (which is how many capitals are typed) — a wider human-settlement
 * walk would drag in metropolitan-area entities that duplicate their city.
 */
function sparqlFor(code: string, minPop: number): string {
  return `${PREFIXES}
SELECT DISTINCT ?city ?pop ?coord WHERE {
  ?country wdt:P297 "${code.toUpperCase()}" .
  ?city wdt:P17 ?country .
  ?city wdt:P1082 ?pop .
  ?city wdt:P625 ?coord .
  { ?city wdt:P31/wdt:P279* wd:Q515 }
  UNION
  { ?city wdt:P31/wdt:P279* wd:Q1549591 }
  FILTER(?pop >= ${minPop})
} ORDER BY DESC(?pop) LIMIT ${QUERY_LIMIT}`;
}

function parsePoint(value: string | undefined): { lat: number; lng: number } | null {
  // Wikidata serialises WKT as POINT(lng lat), longitude first.
  const m = /POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/.exec(value ?? "");
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function qidOf(uri: string | undefined): string | null {
  const m = /\/entity\/(Q\d+)$/.exec(uri ?? "");
  return m ? m[1] : null;
}

/** One skippable retry: QLever occasionally answers 5xx under load. */
async function fetchSparql(endpoint: string, query: string, timeoutMs: number): Promise<SparqlRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${endpoint}?query=${encodeURIComponent(query)}`, {
        headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (res.status === 429 && attempt === 0) {
        // Burst throttling — wait out the window once before giving up.
        await new Promise((r) => setTimeout(r, 2_500));
        continue;
      }
      if (!res.ok) throw new Error(`sparql HTTP ${res.status}`);
      const data = (await res.json()) as { results?: { bindings?: SparqlRow[] } };
      const rows = data?.results?.bindings;
      if (!Array.isArray(rows)) throw new Error("sparql malformed response");
      return rows;
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return [];
}

/** Serialised upstream calls: one country query at a time, politely spaced. */
let queryChain: Promise<unknown> = Promise.resolve();
let lastQueryAt = 0;

function politely<T>(task: () => Promise<T>): Promise<T> {
  const run = queryChain.then(async () => {
    const wait = lastQueryAt + MIN_QUERY_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      lastQueryAt = Date.now();
    }
  });
  queryChain = run.catch(() => {});
  return run;
}

/**
 * Only city-like labels survive. Wikidata has "metropolitan area" entities
 * typed as big cities in a few countries; they sit a few km from the city they
 * describe and would otherwise render as a second, identical-looking card.
 */
const NON_DESTINATION_LABEL =
  /\b(metropolitan area|metro area|metropolis|metropolitan city|metropole|métropole|métropole de|urban agglomeration|agglomeration)\b/iu;

async function labelsFor(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const url =
      `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels` +
      `&languages=en|mul&ids=${ids.join("|")}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(LABEL_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`wikidata HTTP ${res.status}`);
    const data = (await res.json()) as {
      entities?: Record<
        string,
        { labels?: Record<string, { value?: string }>; missing?: string }
      >;
    };
    for (const id of ids) {
      const entity = data.entities?.[id];
      if (!entity || entity.missing) continue;
      const label = entity.labels?.en?.value ?? entity.labels?.mul?.value;
      if (typeof label === "string" && label.trim()) out.set(id, label.trim());
    }
  } catch {
    // Labels are cosmetic: an id without a label is dropped below, and the
    // caller still gets the cities that resolved.
  }
  return out;
}

/** Rows → candidates, most populous first (labels/dedupe happen later). */
function toCandidates(rows: SparqlRow[]): CountryDestination[] {
  const seen = new Set<string>();
  const out: CountryDestination[] = [];
  for (const row of rows) {
    const id = qidOf(row.city?.value);
    const point = parsePoint(row.coord?.value);
    if (!id || !point || seen.has(id)) continue;
    seen.add(id);
    const population = Number(row.pop?.value ?? "");
    out.push({ id, name: "", ...point, population: Number.isFinite(population) ? population : undefined });
  }
  return out.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
}

async function fetchCountry(code: string): Promise<CountryDestinations> {
  let rows: SparqlRow[] = [];
  try {
    for (const minPop of MIN_POP_LADDER) {
      rows = await politely(() =>
        fetchSparql(QLEVER_ENDPOINT, sparqlFor(code, minPop), QUERY_TIMEOUT_MS)
      );
      if (rows.length >= ENOUGH_CITIES) break;
    }
  } catch (err) {
    // QLever throttled or is down. The official endpoint is slower but
    // authoritative; a cold fallback is still cached for a day afterwards.
    console.warn(`[country] QLever failed for ${code}, falling back to WDQS`, err);
    rows = await politely(() =>
      fetchSparql(WDQS_ENDPOINT, sparqlFor(code, MIN_POP_LADDER[0]), WDQS_TIMEOUT_MS)
    );
  }

  const candidates = toCandidates(rows);
  const labels = await labelsFor(candidates.map((p) => p.id));
  const places: CountryDestination[] = [];
  const seenNames = new Set<string>();
  for (const place of candidates) {
    const name = labels.get(place.id);
    if (!name) continue;
    // Metro-area entities are near-duplicates of the city they wrap; drop them
    // BEFORE distance de-dupe so the city itself is the one that survives.
    if (NON_DESTINATION_LABEL.test(name)) continue;
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    // Same place, two entities (city + metropolitan area / old municipality).
    if (places.some((kept) => haversineKm(kept, place) < SAME_PLACE_KM)) continue;
    seenNames.add(nameKey);
    places.push({ ...place, name });
    if (places.length >= RESULT_LIMIT) break;
  }
  return { countryCode: code, places, source: "wikidata" };
}

/**
 * Destinations for an ISO 3166-1 alpha-2 code ("ru"). Cached for a day;
 * concurrent callers for the same country share one upstream query.
 */
export async function countryDestinations(rawCode: string): Promise<CountryDestinations> {
  const code = rawCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) throw new Error("invalid country code");
  await ensureDiskCache();

  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const pending = inflight.get(code);
  if (pending) return pending;

  const task = fetchCountry(code)
    .then((value) => {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(code, { v: DATA_VERSION, at: Date.now(), value });
      void persistDiskCache();
      return value;
    })
    .finally(() => inflight.delete(code));
  inflight.set(code, task);
  return task;
}

/**
 * Best-effort disk cache. The in-process map is the primary cache; this keeps
 * a dev-server restart (or a single-instance deployment restart) from paying
 * for the same country query again. A read-only filesystem is fine — every
 * failure here is ignored.
 */
const DISK_CACHE_PATH = join(process.cwd(), ".cache", "country-destinations.json");
let diskReady: Promise<void> | null = null;
let diskWriteChain: Promise<unknown> = Promise.resolve();

function ensureDiskCache(): Promise<void> {
  if (!diskReady) {
    diskReady = (async () => {
      try {
        const raw = await readFile(DISK_CACHE_PATH, "utf8");
        const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
        const now = Date.now();
        for (const [code, entry] of Object.entries(parsed)) {
          if (
            entry &&
            entry.v === DATA_VERSION &&
            typeof entry.at === "number" &&
            now - entry.at < CACHE_TTL_MS &&
            Array.isArray(entry.value?.places)
          ) {
            cache.set(code, entry);
          }
        }
      } catch {
        // No cache file yet (or not readable) — start empty.
      }
    })();
  }
  return diskReady;
}

function persistDiskCache(): Promise<void> {
  diskWriteChain = diskWriteChain
    .then(async () => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(cache));
      await writeFile(DISK_CACHE_PATH, payload, "utf8");
    })
    .catch(() => {});
  return diskWriteChain.then(() => {});
}
