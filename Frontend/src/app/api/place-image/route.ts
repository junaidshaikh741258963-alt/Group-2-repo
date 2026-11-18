import { NextRequest } from "next/server";
import { enforceRateLimit } from "@/server/rateLimit";
import { recentExcludes, rememberImage } from "@/server/imageHistory";
import { cachedImageById, forgetImageById, rememberImageById } from "@/server/placeImageIdCache";
import { PLACEHOLDER_IMAGE } from "@/lib/freeImages";
import { isImageCategory, placePhotoKey, type ImageCategory } from "@/lib/placePhotoKey";
import { photoId } from "@/lib/placePhotoProviders";
import { warmImgCache } from "@/server/imgCache";
import { isPixabaySurface, type PixabaySurface } from "@/server/pixabayKeys";
import { findPlacePhoto, type PhotoHit } from "@/lib/placePhotoSearch";

export const runtime = "nodejs";

/**
 * Place images for cards/popups — the ONLY frontend image endpoint.
 *
 * Sources (see src/lib/placePhotoSearch.ts): the place's OSM image/Wikidata
 * identity first, then a coordinate-checked Wikipedia/Commons lookup, and
 * only THEN the keyword CDNs (Pexels/Unsplash/Pixabay with "<city>
 * <category>", metadata-guarded) — placeholder last. Every individual
 * lookup has a 3-second budget; keys stay on the server.
 *
 * Caching: in-memory Map — hits are kept until evicted by the cap, misses
 * retry after 5 minutes. Places that arrive with a stable id (from
 * /api/places/city) additionally get a 7-DAY hit cache keyed by that id, so
 * a city + category the user comes back to never re-resolves its images.
 * Upstream searches ride Next's fetch cache (`revalidate: 86400`), so a
 * given place is searched at most once per day even across a server restart.
 *
 * Duplicates: URLs served recently stay in a short-lived registry and every
 * new lookup walks its providers past them — across requests. Within one
 * batch a bounded second pass re-resolves any two cards that still landed on
 * the same photo (fuzzy search loves its popular shots): the fix is stored in
 * the 7-day id cache so it sticks, and when nothing fresh turns up in time
 * the later card drops to the placeholder — a gray tile beats two identical
 * photos side by side.
 *
 * Accepts either a single lookup or a batch `{ items: [...] }` (≤ 32)
 * answered with `{ images: [{ key, image, source }] }` — the Explore grid
 * fetches every card image in ONE request, resolved with Promise.all on the
 * server (the 3 s timeout applies per item). Item fields: name, city?,
 * category?, lat?, lng?, and — from the city listing — id?, wikidata?,
 * osmWikipedia?, osmImage?, surface? ("explore" | "trip" | "detail"; picks
 * that surface's Pixabay key so a busy grid never starves the trip pages or
 * the details window). A single lookup may also pass `busted: <url>`:
 * the cached answer for that place is dropped and re-resolved excluding the
 * dead photo, so a broken image is replaced by another relevant one exactly
 * once (see the failure path in SmartImage → useCardImage).
 */

export type ImageSource =
  | "pexels"
  | "unsplash"
  | "pixabay"
  | "wikipedia"
  | "commons"
  | "openverse"
  | "wikidata"
  | "osm"
  | "google"
  | "placeholder";

const CACHE_MAX = 2000;
const MISS_TTL_MS = 5 * 60_000;
const BATCH_MAX = 32;
/**
 * How many items of a batch are looked up at the same time. Every item
 * queries several providers, so an unbounded batch fired dozens of parallel
 * upstream requests at once — the providers rate-limited, the answers came
 * back slower, and the whole grid waited. A small window keeps the pipe full
 * without swamping the upstreams.
 */
const BATCH_CONCURRENCY = 16;
/**
 * How many of a batch's images are pre-rendered into the byte cache. Only
 * the first rows are inside the viewport; the rest are fetched on demand
 * when they scroll in.
 */
const WARM_LIMIT = 32;
/** Duplicate-breaking shares one total budget — the client aborts at 6 s, so
 * this tail must stay bounded however slow the sources are. */
const DEDUPE_BUDGET_MS = 1_200;
/** SmartImage's card srcset — the warm builds the width this DPR will pick. */
const WARM_WIDTHS = [320, 640, 960];
const CARD_CSS_PX = 350;

interface CacheEntry {
  hit: PhotoHit | null;
  at: number;
}

interface LookupRequest {
  name: string;
  city: string;
  category: ImageCategory;
  lat?: number;
  lng?: number;
  /** Stable place id ("osm:node/123") — enables the 7-day cache. */
  id?: string;
  wikidata?: string;
  wikipedia?: string;
  imageTag?: string;
  /** Which UI surface asked — picks that surface's Pixabay key. */
  surface?: PixabaySurface;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PhotoHit | null>>();

function store(key: string, hit: PhotoHit | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { hit, at: Date.now() });
}

function lookup(
  key: string,
  q: LookupRequest,
  exclude?: ReadonlySet<string>
): Promise<PhotoHit | null> {
  const byId = cachedImageById(q.id);
  if (byId !== undefined) {
    console.info(`[img] "${q.name}" <- 7d id cache (${byId.source})`);
    return Promise.resolve(byId);
  }
  const cached = cache.get(key);
  if (cached && (cached.hit !== null || Date.now() - cached.at < MISS_TTL_MS)) {
    if (cached.hit) console.info(`[img] "${q.name}" <- cache (${cached.hit.source})`);
    return Promise.resolve(cached.hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = findPlacePhoto(q, exclude?.size ? { exclude } : undefined)
    .then((hit) => {
      store(key, hit);
      rememberImageById(q.id, hit);
      console.info(`[img] "${q.name}" (${q.city || "?"}) <- ${hit?.source ?? "no result"}`);
      return hit;
    })
    .catch(() => {
      store(key, null);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

function parseItem(raw: unknown): LookupRequest | null {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const name = String(obj.name ?? "")
    .trim()
    .slice(0, 120);
  if (!name) return null;
  const city = String(obj.city ?? "")
    .trim()
    .slice(0, 120);
  const rawCategory = String(obj.category ?? "attraction").toLowerCase();
  const rawId = String(obj.id ?? "").trim();
  const wikidata = String(obj.wikidata ?? "").trim();
  const wikipedia = String(obj.osmWikipedia ?? "")
    .trim()
    .slice(0, 200);
  const imageTag = String(obj.osmImage ?? "")
    .trim()
    .slice(0, 200);
  const rawSurface = String(obj.surface ?? "").toLowerCase();
  return {
    name,
    city,
    category: isImageCategory(rawCategory) ? rawCategory : "attraction",
    lat: typeof obj.lat === "number" ? obj.lat : undefined,
    lng: typeof obj.lng === "number" ? obj.lng : undefined,
    id: /^osm:(node|way|relation)\/\d{1,15}$/.test(rawId) ? rawId : undefined,
    wikidata: /^Q\d{1,12}$/.test(wikidata) ? wikidata : undefined,
    wikipedia: wikipedia || undefined,
    imageTag: imageTag || undefined,
    surface: isPixabaySurface(rawSurface) ? rawSurface : undefined,
  };
}

function payload(hit: PhotoHit | null): {
  image: string | null;
  source: ImageSource;
  placeholder: string;
} {
  return {
    image: hit?.image ?? null,
    source: hit?.source ?? "placeholder",
    placeholder: PLACEHOLDER_IMAGE,
  };
}

/**
 * Batch second pass: when two cards still landed on the same photo — fuzzy
 * search loves its popular shots, and the same shot can come back under
 * different rendition/query variants — re-resolve the later one with every
 * used photo id excluded; providers then walk further down their result
 * lists. The fix is written to the 7-day id cache so it survives later
 * visits. When nothing fresh turns up within the budget the duplicate drops
 * to the placeholder: two identical photos look broken, a gray tile does not.
 */
async function deDuplicate(
  items: Array<LookupRequest & { key: string }>,
  results: Array<PhotoHit | null>
): Promise<void> {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  for (const [i, hit] of results.entries()) {
    if (!hit) continue;
    const id = photoId(hit.image);
    if (seen.has(id)) duplicates.push(i);
    else seen.add(id);
  }
  const deadline = Date.now() + DEDUPE_BUDGET_MS;
  for (const i of duplicates.slice(0, 6)) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const taken = recentExcludes();
    for (const hit of results) if (hit) taken.add(photoId(hit.image));
    const fresh = await findPlacePhoto(items[i], {
      exclude: taken,
      budgetMs: Math.min(900, left),
    });
    if (fresh && !taken.has(photoId(fresh.image))) {
      results[i] = fresh;
      store(items[i].key, fresh);
      rememberImageById(items[i].id, fresh); // the fix must outlive this request
      console.info(`[img] "${items[i].name}" de-duplicated -> ${fresh.source}`);
    } else {
      results[i] = null;
      // Persist the drop: the key cache holds the miss for 5 minutes, the id
      // cache forgets the duplicate — repeats stay clean instead of replaying
      // the pair and re-fixing on every visit.
      store(items[i].key, null);
      forgetImageById(items[i].id);
      console.info(`[img] "${items[i].name}" duplicate dropped to placeholder`);
    }
  }
}

/**
 * Runs `worker` over every item with at most `limit` in flight, keeping the
 * results in the original order. Used for the batch lookup: the grid's
 * photos are resolved a few at a time so the providers are not hammered.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Srcset width this DPR's card will request — the warm builds exactly that. */
function warmWidthFor(dpr: number): number {
  const need = CARD_CSS_PX * Math.min(Math.max(dpr, 1), 3);
  return WARM_WIDTHS.find((w) => w >= need) ?? WARM_WIDTHS[WARM_WIDTHS.length - 1];
}

export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, { scope: "place-image", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // The browser reports its DPR so the warm-ahead builds the exact srcset
    // width SmartImage will request for each card.
    const dpr = typeof body?.dpr === "number" && Number.isFinite(body.dpr) ? body.dpr : 1;

    // Batch mode — the Explore grid asks for every visible card at once.
    if (Array.isArray(body?.items)) {
      const items: Array<LookupRequest & { key: string }> = [];
      const seen = new Set<string>();
      for (const raw of body.items as unknown[]) {
        const item = parseItem(raw);
        if (!item) continue;
        const key = placePhotoKey(item.category, item.name, item.city);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...item, key });
        if (items.length >= BATCH_MAX) break;
      }
      if (items.length === 0) {
        return Response.json({ error: "items required" }, { status: 400 });
      }
      const seed = recentExcludes();
      const warmWidth = warmWidthFor(dpr);
      const results = await mapWithLimit(items, BATCH_CONCURRENCY, async (item) => {
        const hit = await lookup(item.key, item, seed);
        // Warm the bytes the moment THIS place resolves, not after the slowest
        // place in the batch does. Lookups run concurrently and one obscure
        // place burns its full 3 s budget; warming afterwards meant every card
        // in the batch then waited for its own download on top of that delay.
        // Starting the download here overlaps it with the remaining lookups,
        // so the browser usually finds the exact rendition already on disk.
        if (hit?.image) warmImgCache(hit.image, warmWidth);
        return hit;
      });
      await deDuplicate(items, results);
      for (const [i, hit] of results.entries()) {
        rememberImage(hit?.image);
        // De-duplication can swap an image after the first warm (the URL the
        // browser is about to ask for changed) — warm the replacement too.
        // Only the first few cards are near the viewport; warming the whole
        // batch would spend the sharp CPU on photos nobody can see yet.
        if (hit?.image && i < WARM_LIMIT) warmImgCache(hit.image, warmWidth);
      }
      return Response.json({
        images: items.map((item, i) => ({
          key: item.key,
          image: results[i]?.image ?? null,
          source: (results[i]?.source ?? "placeholder") as ImageSource,
        })),
        placeholder: PLACEHOLDER_IMAGE,
      });
    }

    // Single mode (chat cards, detail sheets, map popups).
    const item = parseItem(body);
    if (!item) return Response.json({ error: "name required" }, { status: 400 });
    const key = placePhotoKey(item.category, item.name, item.city);
    const excludes = recentExcludes();

    // A dead photo URL reported by the browser (`busted`): forget this
    // place's cached answer and re-resolve past that exact photo. The client
    // asks ONCE per place, so a stubborn miss settles on the placeholder
    // instead of looping — and when no other photo exists the lookup still
    // returns null rather than the same broken URL.
    const busted =
      typeof body?.busted === "string" && /^https?:\/\//i.test(body.busted) ? body.busted : null;
    if (busted) {
      cache.delete(key);
      forgetImageById(item.id);
      excludes.add(photoId(busted));
    }

    const hit = await lookup(key, item, excludes);
    rememberImage(hit?.image);
    if (hit?.image) warmImgCache(hit.image, warmWidthFor(dpr));
    return Response.json(payload(hit));
  } catch (err) {
    console.error("Place image error:", err);
    return Response.json(payload(null));
  }
}
