import type { PhotoHit } from "@/lib/placePhotoProviders";
import { isPixabayRedirectUrl } from "@/lib/pixabayCdn";

/**
 * 7-day memory of the final image per place id ("osm:node/123"). Shared by:
 *
 *  - /api/place-image — a repeat lookup of the same place answers from here
 *    without touching any provider;
 *  - /api/places/city — listing items carry `imageUrl` when known, so a
 *    revisit renders its photos on the very first paint (see peekImageById).
 *
 * Hits only: a temporary upstream failure must never stick to a place for a
 * week, so misses are simply not remembered (they retry next time).
 */

const ID_TTL_MS = 7 * 24 * 60 * 60_000;
const ID_CACHE_MAX = 4000;

interface Entry {
  hit: PhotoHit;
  at: number;
}

const idCache = new Map<string, Entry>();

/** The remembered hit for a place id, or undefined when unknown/expired. */
export function cachedImageById(id: string | undefined): PhotoHit | undefined {
  if (!id) return undefined;
  const entry = idCache.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= ID_TTL_MS) {
    idCache.delete(id);
    return undefined;
  }
  // Entries written before the Pixabay CDN rewrite hold the rate-limited
  // `pixabay.com/get/…` hop, which now answers 429 for this host. Retire it so
  // the place re-resolves instead of replaying a broken photo for a week.
  if (isPixabayRedirectUrl(entry.hit.image)) {
    idCache.delete(id);
    return undefined;
  }
  return entry.hit;
}

/** Remember the final image for a place id (null hits are ignored). */
export function rememberImageById(id: string | undefined, hit: PhotoHit | null): void {
  if (!id || !hit) return;
  if (idCache.size >= ID_CACHE_MAX) {
    const oldest = idCache.keys().next().value;
    if (oldest !== undefined) idCache.delete(oldest);
  }
  idCache.set(id, { hit, at: Date.now() });
}

/**
 * Forget a place id — the batch de-dup pass uses this when it drops an
 * unfixable duplicate, so the next lookup re-resolves instead of replaying
 * the same duplicate photo.
 */
export function forgetImageById(id: string | undefined): void {
  if (id) idCache.delete(id);
}

/** First-paint shortcut for listings: the resolved URL when already known. */
export function peekImageById(id: string | undefined): string | undefined {
  return cachedImageById(id)?.image;
}
