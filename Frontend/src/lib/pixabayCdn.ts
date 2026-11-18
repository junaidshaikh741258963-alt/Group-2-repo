/**
 * Pixabay URL helper shared by every server-side photo provider.
 *
 * The API normally hands out `pixabay.com/get/…` renditions, which redirect to
 * the CDN. That redirect endpoint is behind Cloudflare's per-IP rate limiter and
 * answers `429 Rate limit exceeded` — to browsers as well as servers — which
 * made whole galleries fall back to the "no photo" placeholder.
 *
 * The same response also carries `previewURL`, a DIRECT `cdn.pixabay.com` file
 * with a `_<width>` suffix, and the CDN serves every standard size by swapping
 * that suffix (`_150` / `_340` / `_640` / `_1280`). We prefer that URL: it is
 * the identical image, it is not rate-limited, and it still goes through
 * `/api/img`, so Pixabay's no-hotlinking rule is respected.
 */

export interface PixabayImageLike {
  previewURL?: string;
  imageWidth?: number;
}

/** CDN renditions, largest first. `_1920` is not public for most photos. */
const CDN_WIDTHS = [1280, 640, 340, 150] as const;

const CDN_RE =
  /^(https:\/\/cdn\.pixabay\.com\/.+\/)([^/]+)_\d+(\.(?:jpe?g|png|webp))$/i;

/**
 * True for the redirect hop (`pixabay.com/get/…`) that fails with 429 on
 * rate-limited IPs. Used to retire URLs remembered by older cache entries.
 */
export function isPixabayRedirectUrl(url: string): boolean {
  return /^https?:\/\/(?:[a-z0-9-]+\.)?pixabay\.com\/get\//i.test(url);
}

/**
 * Direct CDN URL for a Pixabay hit, capped at `maxWidth` (the card slot wants
 * 640, a fullscreen viewer 1280). Returns null when the hit has no preview or
 * is on another host, so callers can keep their previous fallbacks.
 */
export function pixabayCdnUrl(
  image: PixabayImageLike,
  maxWidth = 1280
): string | null {
  const preview = typeof image.previewURL === "string" ? image.previewURL.trim() : "";
  const match = CDN_RE.exec(preview);
  if (!match) return null;

  // Never ask for a rendition larger than the original — the CDN 404s those.
  const original =
    typeof image.imageWidth === "number" && image.imageWidth > 0
      ? image.imageWidth
      : maxWidth;
  const cap = Math.min(maxWidth, original);
  const width = CDN_WIDTHS.find((w) => w <= cap) ?? CDN_WIDTHS[CDN_WIDTHS.length - 1];
  return `${match[1]}${match[2]}_${width}${match[3]}`;
}
