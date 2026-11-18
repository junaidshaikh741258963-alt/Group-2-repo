/**
 * Server-only KEYED photo providers (Pexels / Unsplash / Pixabay) plus the
 * shared fetch/URL helpers. Without its env key a provider no-ops instantly,
 * so the chain keeps working keyless via the Wikipedia/Commons/Openverse
 * sources; `placePhotoSearch.ts` runs them under one deadline.
 *
 * These providers are the LAST resort for named places: they are only ever
 * queried with "<city> <category>" (never the place name alone) and every
 * candidate whose own tags/alt-text names a different city's landmark is
 * skipped (see `placeKeywordGuard.ts`) — a placeholder beats a wrong photo.
 *
 * Keys (PEXELS_API_KEY / UNSPLASH_ACCESS_KEYS / PIXABAY_API_KEY) stay on the
 * server. A provider answering 429/403 goes on a 10-minute cooldown and later
 * lookups skip it instantly. Unsplash accepts several comma-separated keys
 * (`UNSPLASH_ACCESS_KEYS=key1,key2,…`) and rotates past rate-limited ones.
 */

import { mentionsOtherPlace } from "./placeKeywordGuard";
import { photoId } from "./photoId";
import { pixabayCdnUrl } from "./pixabayCdn";
import { isRecentlyServed, rememberImage } from "@/server/imageHistory";
import {
  cooldownPixabayKey,
  pixabayKeyCandidates,
  type PixabaySurface,
} from "@/server/pixabayKeys";

export { photoId };

const REVALIDATE_SECONDS = 86_400;

export type PhotoProvider =
  | "pexels"
  | "unsplash"
  | "pixabay"
  | "wikipedia"
  | "commons"
  | "openverse"
  | "wikidata"
  | "osm"
  | "google";

export interface PhotoHit {
  image: string;
  source: PhotoProvider;
}

export function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export interface NextFetchInit extends RequestInit {
  next?: { revalidate?: number | false };
}

export interface FetchResult {
  status: number;
  data: unknown;
}

/**
 * fetch + JSON within the budget, surfacing the HTTP status (the cooldown
 * logic needs to tell 429 from 500); any network failure or timeout → null.
 */
export async function fetchJson(
  url: string,
  init: NextFetchInit,
  budgetMs: number
): Promise<FetchResult | null> {
  if (budgetMs <= 0) return null;
  try {
    const res = await fetch(url, {
      ...init,
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: (await res.json()) as unknown };
  } catch {
    return null;
  }
}

/** Only accept https URLs on the CDN we asked — defence against odd payloads. */
export function cdnUrl(value: unknown, hostname: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** Any plain https URL — for CDNs without one fixed host (Pixabay, Openverse). */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// --- provider health: rate-limited providers sit out a cooldown -------------

const COOLDOWN_MS = 10 * 60_000;
const cooldownUntil = new Map<PhotoProvider, number>();

function providerAvailable(id: PhotoProvider): boolean {
  const until = cooldownUntil.get(id);
  if (until === undefined) return true;
  if (Date.now() < until) return false;
  cooldownUntil.delete(id);
  return true;
}

function putOnCooldown(id: PhotoProvider): void {
  cooldownUntil.set(id, Date.now() + COOLDOWN_MS);
}

interface ImageGroup {
  urls: unknown[];
  /** The photo's own tags/alt text — guarded against other-city landmarks. */
  meta?: string;
}

/**
 * Walks candidate groups in order, one preferred rendition per photo,
 * skipping excluded photos and ones served to other cards resolving right
 * now (live registry check — without it concurrent lookups all grab the same
 * top shot), plus other-city landmarks via `guardCity`. A pick is reserved
 * instantly; an excluded photo's other renditions are skipped too.
 */
function pickImage(
  groups: ImageGroup[],
  hostname: string | null,
  exclude: ReadonlySet<string> | undefined,
  guardCity = ""
): string | null {
  for (const group of groups) {
    if (guardCity && mentionsOtherPlace(group.meta, guardCity)) continue;
    for (const value of group.urls) {
      const image = hostname ? cdnUrl(value, hostname) : httpsUrl(value);
      if (!image) continue;
      const id = photoId(image);
      if (exclude?.has(id) || isRecentlyServed(id)) break; // photo is taken — next one
      rememberImage(image);
      return image;
    }
  }
  return null;
}

// --- providers ---------------------------------------------------------------

interface PexelsResponse {
  photos?: Array<{ src?: Record<string, unknown>; alt?: string }>;
}

export async function pexelsPhoto(
  query: string,
  budgetMs: number,
  exclude?: ReadonlySet<string>,
  guardCity = ""
): Promise<PhotoHit | null> {
  const key = process.env.PEXELS_API_KEY?.trim();
  if (!key || !query || budgetMs <= 0 || !providerAvailable("pexels")) return null;
  const res = await fetchJson(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape`,
    { headers: { Authorization: key } },
    budgetMs
  );
  if (!res) return null;
  if (res.status === 429 || res.status === 403) {
    putOnCooldown("pexels");
    return null;
  }
  if (res.status < 200 || res.status >= 300) return null;
  const data = res.data as PexelsResponse | null;
  // Card-sized renditions only — `medium` (~750 px) then `small` (~640 px);
  // `original` would ship multi-megabyte files into a thumbnail slot.
  const image = pickImage(
    (data?.photos ?? [])
      .slice(0, 8)
      .map((photo) => ({ urls: [photo?.src?.medium, photo?.src?.small], meta: photo?.alt })),
    "images.pexels.com",
    exclude,
    guardCity
  );
  return image ? { image, source: "pexels" } : null;
}

interface UnsplashResponse {
  results?: Array<{
    urls?: Record<string, unknown>;
    alt_description?: string;
    description?: string;
  }>;
}

/** Every Unsplash access key we hold (each demo key = its own 50 req/h). */
function unsplashKeys(): string[] {
  const multi = process.env.UNSPLASH_ACCESS_KEYS?.trim();
  const raw = multi ? multi.split(",") : [process.env.UNSPLASH_ACCESS_KEY ?? ""];
  return raw.map((k) => k.trim()).filter(Boolean);
}

/** Round-robin start so concurrent batched lookups spread across the keys. */
let unsplashKeyCursor = 0;
export async function unsplashPhoto(
  query: string,
  budgetMs: number,
  exclude?: ReadonlySet<string>,
  guardCity = ""
): Promise<PhotoHit | null> {
  const keys = unsplashKeys();
  if (keys.length === 0 || !query || budgetMs <= 0 || !providerAvailable("unsplash")) return null;
  const first = unsplashKeyCursor++ % keys.length;
  for (let i = 0; i < keys.length; i++) {
    const idx = (first + i) % keys.length;
    const res = await fetchJson(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${keys[idx]}` } },
      budgetMs
    );
    if (!res) return null; // network/timeout — another key won't help
    if (res.status === 429 || res.status === 403) continue; // this key is spent — try the next
    if (res.status < 200 || res.status >= 300) {
      putOnCooldown("unsplash"); // 401 etc.: misconfigured key, stop hammering
      return null;
    }
    const data = res.data as UnsplashResponse | null;
    const image = pickImage(
      (data?.results ?? []).slice(0, 8).map((r) => ({
        urls: [r?.urls?.small, r?.urls?.regular],
        meta: [r?.alt_description, r?.description].filter(Boolean).join(" "),
      })),
      "images.unsplash.com",
      exclude,
      guardCity
    );
    return image ? { image, source: "unsplash" } : null;
  }
  putOnCooldown("unsplash"); // every key rate-limited
  return null;
}

interface PixabayResponse {
  hits?: Array<{
    previewURL?: string;
    imageWidth?: number;
    largeImageURL?: string;
    webformatURL?: string;
    tags?: string;
  }>;
}

/**
 * Pixabay with the key pool: candidates come from the caller's surface
 * (explore / trip / detail), each key is tried at most once, and a 429'd key
 * parks itself for a minute so the next lookup rotates to a fresh one.
 */
export async function pixabayPhoto(
  query: string,
  budgetMs: number,
  exclude?: ReadonlySet<string>,
  guardCity = "",
  surface?: PixabaySurface
): Promise<PhotoHit | null> {
  if (!query || budgetMs <= 0 || !providerAvailable("pixabay")) return null;
  const keys = pixabayKeyCandidates(surface);
  if (keys.length === 0) return null;

  const deadline = Date.now() + budgetMs;
  let rateLimited = false;
  for (const key of keys) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const res = await fetchJson(
      `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}` +
        `&image_type=photo&orientation=horizontal&safesearch=true&per_page=20`,
      {},
      left
    );
    if (!res) continue; // network blip — the next key may still answer
    if (res.status === 429 || res.status === 403) {
      cooldownPixabayKey(key); // this key sits out; the loop tries the next
      rateLimited = true;
      continue;
    }
    if (res.status < 200 || res.status >= 300) continue;
    const data = res.data as PixabayResponse | null;
    // Card-sized rendition first — 640 px is what a card slot paints — served
    // straight from `cdn.pixabay.com`. The API's `pixabay.com/get/…` URLs
    // redirect to that same CDN but are per-IP rate limited, so they are only
    // fallbacks (see pixabayCdn.ts). Never the raw `imageURL` (needs Pixabay
    // approval) — and hotlinking is not allowed by Pixabay's terms, so the
    // client serves these through /api/img, which downloads and caches the
    // file on our own side. `tags` feed the guard: "taj mahal, agra" must
    // never illustrate a Pune hotel.
    const image = pickImage(
      (data?.hits ?? []).slice(0, 20).map((hit) => ({
        urls: [
          pixabayCdnUrl(hit, 640),
          pixabayCdnUrl(hit, 1280),
          hit?.webformatURL,
          hit?.largeImageURL,
        ],
        meta: hit?.tags,
      })),
      null,
      exclude,
      guardCity
    );
    if (image) return { image, source: "pixabay" };
    return null; // key answered, no usable hit — another key won't change that
  }
  // Every candidate refused as rate-limited: cool the whole provider so later
  // lookups skip Pixabay instantly instead of walking the same wall.
  if (rateLimited) putOnCooldown("pixabay");
  return null;
}
