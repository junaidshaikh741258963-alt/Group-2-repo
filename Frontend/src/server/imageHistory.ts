/**
 * Short-lived registry of place-photo URLs served recently — new lookups keep
 * away from them so two places never show the same photo on one screen.
 * Entries are normalised to the photo id (no rendition query params), so the
 * same picture never sneaks back in via a different crop/resize variant.
 * Module scope: one registry per server process, cleared on restart.
 */

import { photoId } from "@/lib/photoId";

const RECENT_TTL_MS = 10 * 60_000;
const RECENT_MAX = 400;

/** image URL → expiry timestamp. */
const recentImages = new Map<string, number>();

/** URLs still inside the dedupe window (expired entries are pruned here). */
export function recentExcludes(): Set<string> {
  const now = Date.now();
  for (const [url, until] of recentImages) {
    if (until <= now) recentImages.delete(url);
  }
  return new Set(recentImages.keys());
}

/**
 * Live check for one photo id — the providers consult this at pick time, so
 * concurrently resolving cards see each other's picks immediately (the batch
 * seed alone cannot: it is a snapshot taken before any lookup).
 */
export function isRecentlyServed(id: string): boolean {
  const until = recentImages.get(id);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    recentImages.delete(id);
    return false;
  }
  return true;
}

export function rememberImage(url: string | null | undefined): void {
  if (!url) return;
  const id = photoId(url);
  recentImages.delete(id); // re-insert to keep the freshest eviction order
  if (recentImages.size >= RECENT_MAX) {
    const oldest = recentImages.keys().next().value;
    if (oldest !== undefined) recentImages.delete(oldest);
  }
  recentImages.set(id, Date.now() + RECENT_TTL_MS);
}

/** Clear the window (tests). */
export function resetRecentImages(): void {
  recentImages.clear();
}
