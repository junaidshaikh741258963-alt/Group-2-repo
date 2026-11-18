/**
 * Free, keyless image sources shared by every image route.
 * Order matters: Wikimedia Commons first, then Openverse.
 */

/** How long a successful upstream answer is reused (Next fetch cache). */
const REVALIDATE_SECONDS = 86_400;

export interface FreeImage {
  url: string;
  thumbnail: string;
  title: string;
  source: string;
  link: string;
}

function isValidUrl(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Shown when every source fails. Neutral dark tile, no external fetch. */
export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#27272a"/><g fill="none" stroke="#71717a" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><circle cx="320" cy="170" r="52"/><path d="M268 300l56-70 44 52 32-36 52 54z"/></g></svg>`
  );

/**
 * Free image source: Wikimedia Commons search (keyless, no quota).
 *
 * Rides Next's fetch cache (revalidated once a day) — the same upstream
 * answers every lookup would otherwise ask for again, and Wikimedia's search
 * endpoint is slow enough (2–3 s) that a cache miss used to eat the whole
 * image budget.
 *
 * `width` asks Wikimedia for a scaled thumbnail of that size — the gallery
 * wants a big one for its fullscreen viewer, a card wants a small one.
 */
export async function commonsImages(query: string, width = 640): Promise<FreeImage[]> {
  try {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
      `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12` +
      `&prop=imageinfo&iiprop=url%7Csize&iiurlwidth=${width}&format=json&origin=*`;
    const res = await fetch(url, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        pages?: Record<string, { title?: string; imageinfo?: Array<Record<string, unknown>> }>;
      };
    };
    const out: FreeImage[] = [];
    for (const p of Object.values(data?.query?.pages ?? {})) {
      if (!/\.(jpe?g|png|webp)$/i.test(p.title ?? "")) continue;
      const info = p.imageinfo?.[0];
      if (!info) continue;
      const w = typeof info.width === "number" ? info.width : 0;
      if (w && w < 400) continue;
      const u = isValidUrl(info.thumburl) ? info.thumburl : isValidUrl(info.url) ? info.url : "";
      if (!u) continue;
      out.push({
        url: u,
        thumbnail: u,
        title: (p.title ?? "")
          .replace(/^File:/, "")
          .replace(/\.\w+$/, "")
          .slice(0, 160),
        source: "wikimedia commons",
        link: isValidUrl(info.descriptionurl) ? info.descriptionurl : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Free image source: Openverse (Flickr CC etc., keyless).
 *
 * Cached like the Commons lookup: Openverse is rate-limited, and a repeat
 * query must not spend the caller's budget on a request whose answer cannot
 * have changed within the hour.
 */
export async function openverseImages(query: string): Promise<FreeImage[]> {
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=10&mature=false`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        url?: string;
        thumbnail?: string | null;
        width?: number | null;
        title?: string;
        source?: string;
        foreign_landing_url?: string;
        mature?: boolean;
      }>;
    };
    const out: FreeImage[] = [];
    for (const r of data?.results ?? []) {
      if (r.mature || !isValidUrl(r.url)) continue;
      const w = typeof r.width === "number" ? r.width : 0;
      if (w && w < 400) continue;
      // Openverse's own thumbnail is a small server-side crop — use it instead
      // of the original, which can be a multi-megabyte photo.
      const thumb = isValidUrl(r.thumbnail) ? r.thumbnail : r.url;
      out.push({
        url: r.url,
        thumbnail: thumb,
        title: (r.title || query).slice(0, 160),
        source: typeof r.source === "string" ? r.source : "openverse",
        link: isValidUrl(r.foreign_landing_url) ? r.foreign_landing_url : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}
