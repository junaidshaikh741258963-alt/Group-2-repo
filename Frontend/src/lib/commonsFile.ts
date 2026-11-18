/**
 * Pure Wikimedia Commons helpers shared by the server image lookup
 * (`placeCanonicalProviders.ts`) and the client cards.
 *
 * Keeping them free of server imports lets a card compute the exact URL for
 * an OSM `image` tag itself: those places then paint their photo on the very
 * first render instead of waiting for a `/api/place-image` round trip.
 */

const FILE_RE = /\.(jpe?g|png|webp|gif|tiff?)$/i;

/**
 * Commons file name from an OSM `image` / `wikimedia_commons` tag: accepts
 * "File:X.jpg", bare "X.jpg", and commons.wikimedia.org file URLs.
 */
export function commonsFileFromTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  let value = tag.trim();
  if (!value) return null;
  const prefix = "file:";
  if (value.toLowerCase().startsWith(prefix)) value = value.slice(prefix.length).trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      if (!/(^|\.)wikimedia\.org$/i.test(u.hostname)) return null;
      value = decodeURIComponent(u.pathname.replace(/^\/wiki\//i, "").replace(/^\/+/, ""));
      if (value.toLowerCase().startsWith(prefix)) value = value.slice(prefix.length);
    } catch {
      return null;
    }
  }
  value = value.trim();
  if (!value || value.includes("/") || value.startsWith("Category:") || !FILE_RE.test(value)) {
    return null;
  }
  return value;
}

/** Public Commons URL for a file name — redirects to the media CDN. */
export function commonsFilePathUrl(file: string, width = 800): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
    file.replace(/ /g, "_")
  )}?width=${width}`;
}
