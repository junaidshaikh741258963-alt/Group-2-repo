import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import { enforceRateLimit } from "@/server/rateLimit";
import {
  awaitImgWarm,
  ensureImgCacheDir,
  fetchOriginal,
  imgCacheFile,
  imgCacheKey,
  loadSharp,
  sourceForWidth,
} from "@/server/imgCache";

export const runtime = "nodejs";

/**
 * Image proxy + resize cache — the app's "next/image or equivalent".
 *
 * Cards request `/api/img?url=<remote>&w=640` and get a WebP at that width,
 * cached on disk (`.data/imgcache`) and served immutable. Sharp is loaded
 * dynamically: when it is missing (some hosts), the original bytes are
 * streamed through with the same long-lived cache headers, so images still
 * work — just without the size win.
 *
 * The source bytes are fetched ONCE per photo and shared by every width that
 * asks for it (and by the warm-ahead), so a gallery of 24 renditions costs
 * the upstream 24 downloads, not 24 × (widths) — and the warm-ahead can no
 * longer race the proxy into downloading the same file twice.
 *
 * Safety: https only, public hosts only, image content types only, 12 MB cap,
 * 8 s timeout, rate-limited. Anything else is a 404 so the branded fallback
 * art shows instead of a broken frame. A TEMPORARY upstream problem answers
 * 503 (worth retrying) while a photo that simply does not exist answers 404
 * (retrying is pointless) — the client tells the two apart.
 */

const ALLOWED_WIDTHS = new Set([160, 320, 480, 640, 960, 1280, 1600]);
const FETCH_TIMEOUT_MS = 8_000;
/**
 * A photo the upstream does not have is remembered for a minute. Without it,
 * every retry of a broken photo cost ANOTHER upstream request — the client
 * retries once, so a gallery full of missing photos doubled the load on the
 * very upstream that is already struggling.
 *
 * Transient failures (429 / 5xx / timeout) get a much shorter window: the
 * client retries within a second, and a minute-long memory of "upstream is
 * down" made our own cache answer 503 long after the upstream had recovered.
 */
const PERMANENT_FAILURE_TTL_MS = 60_000;
const TRANSIENT_FAILURE_TTL_MS = 2_500;
const FAILURE_MAX = 500;

/** cache key → the status the upstream produced for it. */
const failures = new Map<string, { status: number; at: number }>();

function cachedFailure(key: string): number | null {
  const hit = failures.get(key);
  if (!hit) return null;
  const ttl = hit.status === 404 ? PERMANENT_FAILURE_TTL_MS : TRANSIENT_FAILURE_TTL_MS;
  if (Date.now() - hit.at >= ttl) {
    failures.delete(key);
    return null;
  }
  return hit.status;
}

function rememberFailure(key: string, status: number): void {
  if (failures.size >= FAILURE_MAX) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(key, { status, at: Date.now() });
}
/**
 * How long a request waits for an already-running warm before fetching the
 * bytes itself. Short on purpose: a warm that has not finished by then is
 * usually queued behind others, and the browser needs this frame NOW.
 */
const WARM_GRACE_MS = 400;

function isSafeRemote(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443" && url.port !== "80") return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") && host !== "localhost") return false;
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home|.*\.lan)$/.test(host)) return false;
  // IPv4 literals: block the private/loopback/link-local ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  if (host.includes(":")) return false; // IPv6 literal
  return true;
}

/**
 * Google Places photo media referenced by resource name (`/api/img?gphoto=
 * places/…/photos/…`), with the API key appended HERE, server-side — the
 * browser never sees GOOGLE_PLACES_API_KEY (see placeCanonicalProviders.ts).
 * Without a configured key the branch is inert.
 */
function googlePhotoUrl(resource: string | null): string | null {
  if (!resource || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(resource)) return null;
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) return null;
  return `https://places.googleapis.com/v1/${resource}/media?maxWidthPx=800&key=${encodeURIComponent(key)}`;
}

export async function GET(req: NextRequest) {
  // Generous bucket: every hit is served from the on-disk cache with
  // immutable headers, and an Explore grid + gallery can legitimately ask
  // for ~70 renditions in a minute. Starving this route blanks images.
  const limited = enforceRateLimit(req, { scope: "img", limit: 480, windowMs: 60_000 });
  if (limited) return limited;

  const raw =
    req.nextUrl.searchParams.get("url") ??
    googlePhotoUrl(req.nextUrl.searchParams.get("gphoto"));
  if (!raw) return new Response("Missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Bad url", { status: 400 });
  }
  if (!isSafeRemote(target)) return new Response("Blocked url", { status: 404 });

  const wParam = req.nextUrl.searchParams.get("w");
  const width = wParam ? Number.parseInt(wParam, 10) : 0;
  if (wParam && (!Number.isFinite(width) || !ALLOWED_WIDTHS.has(width))) {
    return new Response("Bad width", { status: 400 });
  }

  const key = imgCacheKey(target.href, width);
  const file = imgCacheFile(target.href, width);
  const etag = `"${key}"`;

  const inm = req.headers.get("if-none-match");
  if (inm && inm.includes(key)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // A photo we already know we cannot serve: answer from memory instead of
  // asking the upstream again (the client retries once — that retry is free).
  const known = cachedFailure(key);
  if (known !== null) {
    return new Response("Upstream unreachable", {
      status: known,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Disk cache first — briefly waiting out any warm already building this
  // exact file, so a card image resolved by /api/place-image is usually
  // served from the warm's result. A slow warm never blocks the response:
  // after the grace period this route fetches upstream in parallel.
  await awaitImgWarm(key, WARM_GRACE_MS);
  try {
    const buf = await fs.readFile(file);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: etag,
      },
    });
  } catch {
    /* not cached yet */
  }

  // Fetch the source bytes — shared with the warm-ahead for this exact
  // rendition. Resizable CDNs are asked for the smallest source that still
  // covers `width` instead of downloading (and making Wikimedia generate) a
  // 1280 px thumbnail for a 640 px tile.
  const sourceHref = sourceForWidth(target.href, width);
  const original = await fetchOriginal(
    sourceHref,
    sourceHref === target.href ? target : new URL(sourceHref),
    FETCH_TIMEOUT_MS
  );
  if (!original.ok) {
    // A photo the upstream does not have is a 404 (retrying is pointless);
    // a timeout, a 429 or a 5xx is a 503 (worth another try).
    const status = original.permanent ? 404 : 503;
    rememberFailure(key, status);
    return new Response(original.permanent ? "Not found" : "Upstream unreachable", {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const buf = original.buf;
  const contentType = original.contentType;

  const sharp = await loadSharp();
  if (sharp) {
    try {
      let pipeline = sharp(buf, { failOn: "none" }).rotate();
      if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
      const out = await pipeline.webp({ quality: 72 }).toBuffer();
      await ensureImgCacheDir();
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, out);
      await fs.rename(tmp, file);
      return new Response(new Uint8Array(out), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: etag,
        },
      });
    } catch {
      // Fall through to the passthrough path.
    }
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      ETag: etag,
    },
  });
}
