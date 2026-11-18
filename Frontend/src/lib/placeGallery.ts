/**
 * Extra photos for a place card, fetched only when a card opens.
 *
 * Free sources only (Wikipedia/Wikimedia) and cached by place name, so the
 * card's carousel can hold a handful of real photos without ever calling the
 * paid image route — that route (cache → Commons/Openverse → Pixabay) stays
 * the job of `usePlaceImage`, which supplies the card's first slide.
 */

/** Slide budget for the card carousel. */
export const MAX_GALLERY_IMAGES = 5;

const cache = new Map<string, string[]>();
const inflight = new Map<string, Promise<string[]>>();

/** File names that are chrome rather than photos of the place. */
const SKIP_FILE =
  /icon|logo|map|flag|coat of arms|seal\b|badge|edit|wiki|commons|blank|ambox|folder|arrow|button|banner|wordmark|question|symbol|star|padlock|crystal|nuvola|diagram|chart|graph|screenshot|locator|special.marker|osm|landsat|satellite|aerial|terrain|topograph|atlas|prov\b/i;

const PHOTO_EXT = /\.(?:jpe?g|png|webp)$/i;

function cleanFileTitle(title: string): string | null {
  const name = title
    .replace(/^File:/i, "")
    .replace(/["'\\_]+/g, " ")
    .trim();
  if (!PHOTO_EXT.test(name)) return null;
  if (SKIP_FILE.test(name)) return null;
  return name;
}

/**
 * The same chrome check for a full URL. The article's LEAD image is returned
 * as a URL (not a file title), so without this a locator map — e.g. Bali's
 * SVG "special marker" map — became the card's hero photo. Only raster files
 * with a photo-ish name are allowed through.
 */
function isPhotoUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    const file = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    if (!file) return false;
    // Thumbnail URLs carry the width prefix ("500px-Name.jpg") — strip it so
    // the chrome-name check sees the real file name.
    const name = file.replace(/^\d+px-/, "");
    return cleanFileTitle(name) !== null;
  } catch {
    return false;
  }
}

async function wikiJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!res.ok) return null;
  return res.json();
}

interface WikiPage {
  title?: string;
  original?: { source?: string };
  images?: Array<{ title?: string }>;
}

/**
 * Main image of the place's article plus a few other photos from it.
 * Returns [] on any failure — the card falls back to its single image.
 */
async function lookup(name: string): Promise<string[]> {
  const titles = encodeURIComponent(name.trim());
  const listUrl =
    `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages%7Cimages` +
    `&piprop=original&pithumbsize=1200&imlimit=50&redirects=1` +
    `&titles=${titles}&format=json&origin=*`;

  const list = (await wikiJson(listUrl)) as { query?: { pages?: Record<string, WikiPage> } } | null;
  const page = list?.query?.pages ? Object.values(list.query.pages)[0] : null;
  if (!page) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url?: string) => {
    if (url && /^https?:\/\//i.test(url) && isPhotoUrl(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };

  push(page.original?.source);

  const files = (page.images ?? [])
    .map((i) => i.title ?? "")
    .filter((t) => cleanFileTitle(t) !== null)
    .slice(0, 16);
  if (files.length > 0 && out.length < MAX_GALLERY_IMAGES) {
    const infoUrl =
      `https://en.wikipedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url%7Csize` +
      `&iiurlwidth=1200&format=json&origin=*&titles=${encodeURIComponent(files.join("|"))}`;
    const info = (await wikiJson(infoUrl)) as {
      query?: {
        pages?: Record<string, { imageinfo?: Array<{ thumburl?: string; url?: string }> }>;
      };
    } | null;
    const pages = info?.query?.pages ? Object.values(info.query.pages) : [];
    for (const p of pages) push(p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url);
  }

  return out.slice(0, MAX_GALLERY_IMAGES);
}

/**
 * Photos for the carousel: the place's article image first, then its other
 * photos, capped at {@link MAX_GALLERY_IMAGES}. Resolves to [] when nothing
 * usable exists, so callers can keep showing their own image.
 */
export function fetchPlaceGallery(name: string): Promise<string[]> {
  const key = name.trim().toLowerCase();
  if (!key) return Promise.resolve([]);

  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = lookup(key)
    .then((urls) => {
      cache.set(key, urls);
      return urls;
    })
    .catch(() => {
      const empty: string[] = [];
      // Don't cache failures — a later open can retry.
      return empty;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}
