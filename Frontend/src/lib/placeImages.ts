import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { recImage, type RecType } from "./recommendations";
import { fetchPlaceGallery } from "./placeGallery";
import { useInView } from "./useInView";
import { placePhotoKey, type ImageCategory } from "./placePhotoKey";

export type { ImageCategory } from "./placePhotoKey";
/** Re-exported so card surfaces derive the same key without a second import. */
export { placePhotoKey };

/** RecType → image category (drives the "city + category" fallback query). */
export function categoryForType(type: RecType): ImageCategory {
  if (type === "hotel") return "hotel";
  if (type === "restaurant") return "restaurant";
  if (type === "destination") return "city";
  return "landmark";
}

const cache = new Map<string, { url: string | null; at: number }>();
const inflight = new Map<string, Promise<string | null>>();
/**
 * How many broken photos one place may step past. A card can burn its first
 * retry on the record photo, then fail again on the replacement — with a
 * single retry the second failure left the card on its fallback forever.
 * Two is enough to survive "immediate photo → replacement → one more" while
 * still making an infinite error loop impossible.
 */
const MAX_DEAD_RETRIES = 2;
/** Places → broken-photo retries already used. */
const deadRetries = new Map<string, number>();

/**
 * Claims one broken-URL retry for the place. Returns true while the place has
 * attempts left, false after — the caller's error handler can then never loop,
 * no matter how many surfaces report the same dead photo.
 */
export function claimDeadRetry(key: string): boolean {
  const used = deadRetries.get(key) ?? 0;
  if (used >= MAX_DEAD_RETRIES) return false;
  deadRetries.set(key, used + 1);
  return true;
}
/** Key → live subscribers (grid card, map popup, cluster row, details window). */
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const onChange of set) onChange();
}

/**
 * All lookups requested within the same tick are coalesced into POSTs to
 * /api/place-image, where the server resolves each request with Promise.all —
 * each item under its own budget, canonical sources racing in parallel. This
 * replaces the old 3-at-a-time client queue: the Explore grid's visible cards
 * now resolve in a handful of parallel round trips instead of trickling in.
 *
 * A window is split into CHUNK_MAX-sized requests fired in parallel. That
 * split is what keeps cards independent: the server answers a request only
 * when ALL its items are done, so one photo-less place — which burns the full
 * 3 s budget — would otherwise stall every card in a 32-item batch until it
 * gave up. With 8-item chunks the same place holds at most its 7 neighbours,
 * and the chunks without a straggler paint as soon as they land. Server-side
 * `inflight` dedupes any place that shows up in two chunks at once.
 *
 * Chat/trip cards use single lookups instead (TRIP_CONCURRENCY at a time):
 * a chat row is small, and one card whose place has no photo must never make
 * the other five wait the full 3 s budget before any of them can paint.
 */
const BATCH_WINDOW_MS = 20;
const BATCH_MAX = 32;
const CHUNK_MAX = 16;
const TRIP_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 10_000;
/** A failed lookup is retried after this long instead of sticking all session. */
const NULL_TTL_MS = 90_000;

interface QueuedItem {
  key: string;
  name: string;
  city: string;
  category: ImageCategory;
  lat?: number;
  lng?: number;
  id?: string;
  wikidata?: string;
  wikipedia?: string;
  imageTag?: string;
  /** A dead URL for this place — the server re-resolves past that photo. */
  busted?: string;
  /** UI surface — selects that surface's Pixabay key server-side. */
  surface?: "explore" | "trip" | "detail";
}

let queue: QueuedItem[] = [];
let draining = false;
/** Chat/trip cards: individual lookups so no card waits on a neighbour. */
const tripQueue: QueuedItem[] = [];
let tripActive = 0;
/** Resolvers per distinct place key, settled when its batch comes back. */
const waiters = new Map<string, Array<(url: string | null) => void>>();

function enqueue(item: QueuedItem): void {
  if (item.surface === "trip") {
    tripQueue.push(item);
    pumpTrip();
    return;
  }
  queue.push(item);
  if (!draining) {
    draining = true;
    setTimeout(() => void drain(), BATCH_WINDOW_MS);
  }
}

function settle(key: string, url: string | null): void {
  const pending = waiters.get(key);
  if (pending) {
    waiters.delete(key);
    for (const resolve of pending) resolve(url);
  }
  inflight.delete(key);
  notify(key); // every subscribed surface re-reads the cache in one pass
}

/** The DPR the browser picks srcset widths with — lets the server warm the
 * exact /api/img width each card will request. */
function deviceDpr(): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return Math.min(Math.max(dpr, 1), 3);
}

/** Wire shape of one place; `osm*` names are what the route parses. */
function requestItem(item: QueuedItem) {
  return {
    name: item.name,
    city: item.city,
    category: item.category,
    lat: item.lat,
    lng: item.lng,
    id: item.id,
    wikidata: item.wikidata,
    osmWikipedia: item.wikipedia,
    osmImage: item.imageTag,
    busted: item.busted,
    surface: item.surface,
  };
}

/** One trip/chat card's lookup: settles on its own response, so a neighbour
 *  that burns the server's 3 s budget cannot delay this card's photo. */
async function sendSingle(item: QueuedItem): Promise<void> {
  try {
    const res = await fetch("/api/place-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dpr: deviceDpr(), ...requestItem(item) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = res.ok ? ((await res.json()) as { image?: unknown }) : null;
    const url = typeof data?.image === "string" ? data.image : null;
    cache.set(item.key, { url, at: Date.now() });
    settle(item.key, url);
  } catch {
    cache.set(item.key, { url: null, at: Date.now() });
    settle(item.key, null);
  }
}

function pumpTrip(): void {
  while (tripActive < TRIP_CONCURRENCY && tripQueue.length > 0) {
    const next = tripQueue.shift();
    if (!next) return;
    tripActive += 1;
    void sendSingle(next).finally(() => {
      tripActive -= 1;
      pumpTrip();
    });
  }
}

/** Resolve every item of one chunk: paint its cards as soon as ITS response
 *  lands (not when the slowest chunk of the window does), or null them on a
 *  timeout so no skeleton can ever be left waiting. Never rejects. */
async function sendChunk(batch: QueuedItem[]): Promise<void> {
  try {
    const res = await fetch("/api/place-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dpr: deviceDpr(),
        // undefined fields are dropped by JSON.stringify.
        items: batch.map(requestItem),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = res.ok
      ? ((await res.json()) as { images?: Array<{ key?: unknown; image?: unknown }> })
      : null;
    const returned = new Map<string, string>();
    for (const entry of data?.images ?? []) {
      if (typeof entry.key === "string" && typeof entry.image === "string") {
        returned.set(entry.key, entry.image);
      }
    }
    for (const item of batch) {
      const url = returned.get(item.key) ?? null;
      cache.set(item.key, { url, at: Date.now() });
      settle(item.key, url);
    }
    console.info(`[img] batch ${batch.length} → ${returned.size} resolved`);
  } catch {
    // Timeout or offline: remember the miss briefly (it self-heals after
    // NULL_TTL_MS); the server re-tries failed places too.
    for (const item of batch) {
      cache.set(item.key, { url: null, at: Date.now() });
      settle(item.key, null);
    }
  }
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const window = queue.slice(0, BATCH_MAX);
    queue = queue.slice(window.length);
    const chunks: QueuedItem[][] = [];
    for (let i = 0; i < window.length; i += CHUNK_MAX) {
      chunks.push(window.slice(i, i + CHUNK_MAX));
    }
    // Parallel, independently settled — see CHUNK_MAX. sendChunk never
    // rejects, so allSettled just paces the next window.
    await Promise.allSettled(chunks.map((chunk) => sendChunk(chunk)));
  }
  draining = false;
}

/** Per-place lookup hints: coordinates, city hint, and OSM/Wikidata identity. */
export interface PlaceImageHints {
  lat?: number;
  lng?: number;
  city?: string;
  /** Stable place id — server keeps the resolved image for 7 days. */
  id?: string;
  wikidata?: string;
  /** OSM `wikipedia` tag — the exact article to look up. */
  wikipedia?: string;
  /** OSM `image` tag — a Commons file name tagged on the place. */
  imageTag?: string;
  /**
   * Which UI surface asked ("explore" | "trip" | "detail") — the server
   * spends that surface's own Pixabay key, so a busy Explore grid never
   * starves the trip pages or the details window.
   */
  surface?: "explore" | "trip" | "detail";
}

/** Sync read of the session's resolved image for a place key (or null). */
export function peekPlaceImage(key: string): string | null {
  return cache.get(key)?.url ?? null;
}

/**
 * Publish a resolved URL under `key`: every subscribed surface updates at
 * once and later lookups for the same place read it back instantly. The
 * Explore card uses this to hand its exact photo to the details window, the
 * map card and the cluster stack — no second lookup for a place that is
 * already on screen.
 */
export function publishPlaceImage(key: string, url: string | null): void {
  cache.set(key, { url, at: Date.now() });
  notify(key);
}

/**
 * Subscribe to one place key's resolved image (null until something is
 * known). Snapshots are plain Map reads, so React can diff them cheaply and
 * re-render only the surfaces that key actually changed.
 */
export function usePlaceImageSync(key: string): string | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(key) ?? new Set<() => void>();
      if (!listeners.has(key)) listeners.set(key, set);
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key]
  );
  const getSnapshot = useCallback(() => peekPlaceImage(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Renditions the details window's hero asks /api/img for (see SmartImage). */
const PRELOAD_WIDTHS = [640, 960];
const preloaded = new Set<string>();
/** Keeps in-flight preloads from being collected mid-download. */
const preloadKeepAlive: HTMLImageElement[] = [];

/**
 * Warm the browser cache with the renditions a details window will request
 * (`/api/img` at 640/960 px). Called on card hover/focus, where the photo is
 * already known — opening the window then paints its hero from cache with no
 * extra round trip. Deduped per URL, so re-hovering costs nothing.
 */
export function preloadDetailImage(url: string | null | undefined): void {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (typeof Image === "undefined") return;
  for (const width of PRELOAD_WIDTHS) {
    const target = `/api/img?url=${encodeURIComponent(url)}&w=${width}`;
    if (preloaded.has(target)) continue;
    preloaded.add(target);
    const img = new Image();
    img.decoding = "async";
    img.src = target;
    preloadKeepAlive.push(img);
    if (preloadKeepAlive.length > 48) preloadKeepAlive.shift();
  }
}

/**
 * Client-side per-place image lookup through /api/place-image. Resolves to a
 * canonical (Wikipedia/Commons/OSM/Wikidata) or keyword-CDN URL, or null when
 * every source (or the 3-second server budget) ran out. Cached by place for
 * the session.
 *
 * Pass `options.busted` with a URL that failed to load: the cached answer for
 * the place is skipped and the server re-resolves past that exact photo, so
 * the caller gets one different image instead of the same dead one.
 */
export async function fetchPlaceImage(
  name: string,
  category: ImageCategory = "landmark",
  hints?: PlaceImageHints,
  options?: { busted?: string }
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const key = placePhotoKey(category, trimmed, hints?.city ?? "");
  const busted = options?.busted?.trim();

  if (!busted) {
    const cached = cache.get(key);
    if (cached && (cached.url !== null || Date.now() - cached.at < NULL_TTL_MS)) {
      return cached.url;
    }
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const task = new Promise<string | null>((resolve) => {
    const list = waiters.get(key);
    if (list) list.push(resolve);
    else waiters.set(key, [resolve]);
    enqueue({
      key,
      name: trimmed,
      city: (hints?.city ?? "").trim(),
      category,
      lat: hints?.lat,
      lng: hints?.lng,
      id: hints?.id,
      wikidata: hints?.wikidata,
      wikipedia: hints?.wikipedia,
      imageTag: hints?.imageTag,
      busted,
      surface: hints?.surface,
    });
  });
  if (!inflight.has(key)) inflight.set(key, task);
  return task;
}

export interface PlaceImageSource {
  name: string;
  type: RecType;
  image?: string;
  lat?: number;
  lng?: number;
  /** City/area hint — keeps restaurant/hotel lookups from matching elsewhere. */
  city?: string;
  id?: string;
  wikidata?: string;
  wikipedia?: string;
  imageTag?: string;
  /**
   * Which UI surface asked ("explore" | "trip" | "detail") — the server
   * spends that surface's own Pixabay key, so a busy Explore grid never
   * starves the trip pages or the details window.
   */
  surface?: "explore" | "trip" | "detail";
}

/**
 * Resolve a display image for a place: the place's own image (or a city stock
 * photo for destinations) immediately, otherwise a fetched lookup (canonical
 * sources first, then keyword CDNs). Shared by recommendation cards and map
 * previews.
 *
 * Pass `hostRef` (the card element) to hold the lookup until the card scrolls
 * near the viewport — off-screen cards cost nothing. The horizontal margin
 * warms the next few cards of a carousel, so swiping a chat row shows photos
 * that were already resolved instead of starting a fresh lookup per swipe.
 */
export function usePlaceImage(
  item: PlaceImageSource,
  hostRef?: { current: HTMLElement | null }
): { url: string | null; onImgError: () => void } {
  const { name, image, type, lat, lng, city, id, wikidata, wikipedia, imageTag, surface } = item;
  const immediate = recImage({ type, name, image, imageTag });
  const nearViewport = useInView(hostRef, "600px 1200px");
  const category = categoryForType(type);
  const key = placePhotoKey(category, name, city ?? "");
  // Subscribes to the shared store: the grid card, map card, cluster row and
  // details window all render the same resolved URL for this place.
  const shared = usePlaceImageSync(key);
  const [immediateDead, setImmediateDead] = useState(false);

  useEffect(() => {
    // A dead immediate image is recovered by onImgError's single bounded
    // re-resolution instead — never a second concurrent lookup here.
    if (immediate || !nearViewport) return;
    let cancelled = false;
    fetchPlaceImage(name, category, {
      lat,
      lng,
      city,
      id,
      wikidata,
      wikipedia,
      imageTag,
      surface,
    }).then((url) => {
      if (cancelled) return;
      publishPlaceImage(key, url);
      if (url) return;
      // Every canonical/stock source missed: fall back to the free Wikipedia
      // gallery (the same source the map card's carousel uses) so a card is
      // never left with an empty frame just because one lookup blipped.
      fetchPlaceGallery(name).then((urls) => {
        const fallback = urls[0] ?? null;
        if (!cancelled && fallback) publishPlaceImage(key, fallback);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    name,
    category,
    lat,
    lng,
    city,
    id,
    wikidata,
    wikipedia,
    imageTag,
    surface,
    immediate,
    immediateDead,
    nearViewport,
    key,
  ]);

  // A dead recommendation photo falls back to a looked-up one, and a dead
  // REPLACEMENT may be retried once more. claimDeadRetry keeps this bounded,
  // so a place whose sources keep returning unusable URLs cannot loop.
  const onImgError = useCallback(() => {
    const dead = immediateDead ? shared : immediate;
    if (!immediateDead && immediate) setImmediateDead(true);
    if (!dead || !claimDeadRetry(key)) return;
    fetchPlaceImage(
      name,
      category,
      { lat, lng, city, id, wikidata, wikipedia, imageTag, surface },
      { busted: dead }
    ).then((url) => publishPlaceImage(key, url && url !== dead ? url : null));
  }, [
    immediateDead,
    shared,
    immediate,
    key,
    name,
    category,
    lat,
    lng,
    city,
    id,
    wikidata,
    wikipedia,
    imageTag,
    surface,
  ]);

  return { url: immediateDead ? shared : (immediate ?? shared), onImgError };
}
