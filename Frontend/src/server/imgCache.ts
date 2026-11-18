/**
 * Shared `.data/imgcache` plumbing for /api/img and /api/place-image.
 *
 * /api/img resolves a photo URL → WebP bytes on disk; /api/place-image WARMs
 * that same disk cache the moment a card's photo URL is known (fire-and-forget,
 * width picked from the device pixel ratio the client reported). By the time
 * the browser asks /api/img for the card, the file is already there — the
 * cold upstream fetch + resize hop is off the critical path of first paint.
 *
 * Keys must stay byte-identical to the proxy route's (`href|width`), or the
 * warm would land where nobody looks. Concurrency is capped so a full Explore
 * batch never opens dozens of simultaneous upstream connections.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const IMG_CACHE_DIR = path.join(process.cwd(), ".data", "imgcache");

/** Transparent identity for the proxy's first attempt at an image. */
const PROXY_HEADERS: Record<string, string> = {
  "user-agent": "TripCraft/1.0 (image proxy; +https://tripcraft.local)",
  accept: "image/avif,image/webp,image/*;q=0.9,*/*;q=0.5",
};
/**
 * Browser identity for hosts that block unknown user agents (CDN bot rules).
 * Only used after a 403/406, never as the default.
 */
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

/** Same key /api/img serves under (`width` 0 = original bytes). */
export function imgCacheKey(href: string, width: number): string {
  return createHash("sha256")
    .update(`${href}|${width || "orig"}`)
    .digest("hex")
    .slice(0, 32);
}

export function imgCacheFile(href: string, width: number): string {
  return path.join(IMG_CACHE_DIR, `${imgCacheKey(href, width)}.webp`);
}

export async function ensureImgCacheDir(): Promise<void> {
  await fs.mkdir(IMG_CACHE_DIR, { recursive: true });
}

/**
 * Pixabay's direct CDN renditions that are reliably generated (ascending).
 * `_340` often answers 403 even when `_640` and `_150` exist, so it must not
 * be requested here.
 */
const PIXABAY_CDN_WIDTHS = [150, 640, 1280] as const;
const PIXABAY_CDN_RE =
  /^(https:\/\/cdn\.pixabay\.com\/.+\/)([^/]+)_\d+(\.(?:jpe?g|png|webp))$/i;
const WIKIMEDIA_THUMB_RE =
  /^(https?:\/\/[^/]*wikimedia\.org\/.+\/thumb\/.+\/)(\d+)px-(.+)$/i;
/**
 * Direct Wikimedia thumbnail requests are rejected unless the width is one of
 * the production "thumbnail steps" (PHP endpoints such as imageinfo round
 * arbitrary widths up to these). Asking for 640 px would get a 400 instead of
 * a smaller image, so map the target up to the nearest step.
 */
const WIKIMEDIA_THUMB_WIDTHS = [120, 250, 330, 500, 960, 1280, 1920, 3840] as const;

function wikimediaThumbWidth(width: number): number {
  return (
    WIKIMEDIA_THUMB_WIDTHS.find((w) => w >= width) ??
    WIKIMEDIA_THUMB_WIDTHS[WIKIMEDIA_THUMB_WIDTHS.length - 1]
  );
}

/**
 * The upstream rendition worth downloading for a target width.
 *
 * Wikimedia and Pixabay generate/serve every size from the original, so asking
 * a 640 px tile for the 1280 px file wastes bandwidth and — on Wikimedia —
 * waits for a much larger thumbnail to be generated. We keep the same cache
 * key (the URL the page uses) but fetch a smaller source when the URL exposes
 * a resizable rendition. Never enlarges: a source already smaller than the
 * target is left alone.
 */
export function sourceForWidth(href: string, width: number): string {
  if (!width) return href;

  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();

    // `Special:FilePath` is Commons' resize endpoint (`?width=800`).
    if (/(^|\.)wikimedia\.org$/.test(host) && /\/wiki\/Special:FilePath\//i.test(url.pathname)) {
      const current = Number.parseInt(url.searchParams.get("width") ?? "", 10);
      if (!Number.isFinite(current) || width < current) {
        url.searchParams.set("width", String(width));
        return url.toString();
      }
      return href;
    }

    if (host === "cdn.pixabay.com") {
      const match = PIXABAY_CDN_RE.exec(href);
      if (match) {
        const current = Number.parseInt(/_(\d+)\.[a-z]+$/i.exec(href)?.[1] ?? "", 10);
        const target =
          PIXABAY_CDN_WIDTHS.find((w) => w >= width) ??
          PIXABAY_CDN_WIDTHS[PIXABAY_CDN_WIDTHS.length - 1];
        if (!Number.isFinite(current) || target < current) {
          return `${match[1]}${match[2]}_${target}${match[3]}`;
        }
      }
    }
  } catch {
    return href;
  }

  const thumb = WIKIMEDIA_THUMB_RE.exec(href);
  if (thumb) {
    const current = Number.parseInt(thumb[2], 10);
    const target = wikimediaThumbWidth(width);
    if (!Number.isFinite(current) || target < current) {
      return `${thumb[1]}${target}px-${thumb[3]}`;
    }
  }
  return href;
}

/** Minimal structural view of sharp — decouples us from its CJS/ESM interop types. */
export interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(opts: { width: number; withoutEnlargement?: boolean }): SharpPipeline;
  webp(opts?: { quality?: number }): { toBuffer(): Promise<Buffer> };
}
type SharpFactory = (
  input: Buffer,
  options?: { failOn?: "none" | "warning" | "error" }
) => SharpPipeline;

let sharpPromise: Promise<SharpFactory | null> | null = null;
export function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((m) => ((m as { default?: unknown }).default ?? m) as unknown as SharpFactory)
      .catch(() => null);
  }
  return sharpPromise;
}

// --- warm-ahead: pre-build the WebP before the browser asks for it ----------

const WARM_CONCURRENCY = 10;
const WARM_TIMEOUT_MS = 8_000;
const WARM_MAX_BYTES = 12 * 1024 * 1024;

/* --- shared ORIGINAL bytes -------------------------------------------------
 *
 * Every request for the SAME source URL shares one download: the warm-ahead
 * and the proxy route converge on the same in-flight fetch instead of racing
 * each other and throwing one copy away. Resizable CDNs may give different
 * widths different source renditions (see `sourceForWidth`) — those are
 * separate, deliberately smaller downloads. */

/** Concurrent upstream photo downloads — a gallery of 24 must not burst. */
const ORIGINALS_CONCURRENCY = 12;
/** Originals kept in memory (photos are ~100–500 KB, so this is a few MB). */
const ORIGINALS_MAX = 32;
/** In-memory originals expire quickly; the resized files on disk are the cache. */
const ORIGINALS_TTL_MS = 5 * 60_000;
/** Bigger than this is not worth holding in memory (the proxy streams it). */
const ORIGINALS_MAX_BYTES = 6 * 1024 * 1024;

interface Original {
  buf: Buffer;
  contentType: string;
  at: number;
}

/**
 * The outcome of a source fetch. `permanent` means the upstream simply does
 * not have the photo (404) — retrying is pointless. A timeout, a 429 or a 5xx
 * is transient and worth another try.
 */
export type OriginalResult =
  | { ok: true; buf: Buffer; contentType: string }
  | { ok: false; permanent: boolean };

const originals = new Map<string, Original>();
/** In-flight original fetches — one request per URL, however many widths ask. */
const inflightOriginals = new Map<string, Promise<OriginalResult>>();
let originalsActive = 0;
const originalsQueue: Array<() => void> = [];

function acquireOriginalSlot(): Promise<void> {
  if (originalsActive < ORIGINALS_CONCURRENCY) {
    originalsActive++;
    return Promise.resolve();
  }
  // The slot is granted (and counted) at wake-up time, not at enqueue time.
  return new Promise((resolve) =>
    originalsQueue.push(() => {
      originalsActive++;
      resolve();
    })
  );
}

function releaseOriginalSlot(): void {
  originalsActive = Math.max(0, originalsActive - 1);
  originalsQueue.shift()?.();
}

/** A cached original, or undefined (expired entries are pruned here). */
export function cachedOriginal(href: string): Original | undefined {
  const hit = originals.get(href);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= ORIGINALS_TTL_MS) {
    originals.delete(href);
    return undefined;
  }
  return hit;
}

/**
 * The source bytes for a photo, fetched at most once per URL. Returns null
 * when the upstream has no image (a genuine miss) — the caller decides
 * whether to retry.
 */
export async function fetchOriginal(
  href: string,
  url: URL,
  timeoutMs = WARM_TIMEOUT_MS
): Promise<OriginalResult> {
  const cached = cachedOriginal(href);
  if (cached) return { ok: true, buf: cached.buf, contentType: cached.contentType };
  const pending = inflightOriginals.get(href);
  if (pending) return pending;

  const task = (async (): Promise<OriginalResult> => {
    await acquireOriginalSlot();
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const request = (headers: Record<string, string>) =>
        fetch(url, { signal, headers, redirect: "follow" });
      // Some hosts (hotel sites behind a CDN, for example) answer the honest
      // proxy UA with 403 while serving the same bytes to a browser. Try the
      // transparent identity first, then a browser identity before giving up —
      // otherwise those photos could never be painted anywhere in the app.
      let res = await request(PROXY_HEADERS);
      if (res.status === 403 || res.status === 406) {
        await res.body?.cancel().catch(() => {});
        res = await request(BROWSER_HEADERS);
      }
      // 404/410: the photo does not exist. Anything else (429, 5xx) may.
      if (!res.ok) {
        return { ok: false, permanent: res.status === 404 || res.status === 410 };
      }
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!contentType.startsWith("image/")) return { ok: false, permanent: true };
      const declared = Number.parseInt(res.headers.get("content-length") ?? "0", 10);
      if (declared > WARM_MAX_BYTES) return { ok: false, permanent: true };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > WARM_MAX_BYTES) {
        return { ok: false, permanent: true };
      }
      const original: Original = { buf, contentType, at: Date.now() };
      if (buf.length <= ORIGINALS_MAX_BYTES) {
        if (originals.size >= ORIGINALS_MAX) {
          const oldest = originals.keys().next().value;
          if (oldest !== undefined) originals.delete(oldest);
        }
        originals.set(href, original);
      }
      return { ok: true, buf, contentType };
    } catch {
      // A timeout or a socket error — transient.
      return { ok: false, permanent: false };
    } finally {
      releaseOriginalSlot();
    }
  })().finally(() => inflightOriginals.delete(href));

  inflightOriginals.set(href, task);
  return task;
}

/** Test hook — drop the in-memory originals. */
export function resetOriginals(): void {
  originals.clear();
  inflightOriginals.clear();
}

let warmActive = 0;
const warmQueue: Array<() => void> = [];
/** In-flight warms by cache key — /api/img awaits one instead of re-fetching. */
const warming = new Map<string, Promise<void>>();

/**
 * Awaits a warm for this cache key — but only up to `graceMs`.
 *
 * The proxy used to wait out the WHOLE warm, which queues behind up to six
 * others (each an 8 s upstream fetch + a sharp resize): a card whose bytes
 * were not ready yet blocked for seconds on work it could have done itself.
 * With a grace period the request serves from disk when the warm won the
 * race, and otherwise fetches upstream in parallel — the two paths converge
 * on the same cache file (written via tmp + atomic rename), so the loser's
 * work is simply discarded, never served.
 */
export async function awaitImgWarm(key: string, graceMs = 0): Promise<void> {
  const inFlight = warming.get(key);
  if (!inFlight) return;
  if (graceMs <= 0) {
    await inFlight;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    inFlight,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
      // Don't hold the process open just to release a waiter nobody awaits.
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function acquireWarmSlot(): Promise<void> {
  if (warmActive < WARM_CONCURRENCY) {
    warmActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    warmQueue.push(() => {
      warmActive++;
      resolve();
    })
  );
}

/**
 * Fire-and-forget: fetch one image, resize it to `width` and store it under
 * the key /api/img serves from. Best effort by design — every failure is a
 * silent no-op and the proxy route simply does the work later, as before.
 *
 * The source bytes come from the SHARED original fetch, so a warm and the
 * proxy route asking for the same photo at the same time cost ONE upstream
 * download between them, not two.
 */
export function warmImgCache(href: string, width: number): void {
  let target: URL;
  try {
    target = new URL(href);
  } catch {
    return;
  }
  if (target.protocol !== "https:" || target.username || target.password) return;

  const key = imgCacheKey(href, width);
  if (warming.has(key)) return;

  const task = (async () => {
    await acquireWarmSlot();
    try {
      const file = imgCacheFile(href, width);
      const exists = await fs
        .stat(file)
        .then(() => true)
        .catch(() => false);
      if (exists) return;

      const sourceHref = sourceForWidth(href, width);
      const original = await fetchOriginal(sourceHref, new URL(sourceHref));
      if (!original.ok) return;

      const sharp = await loadSharp();
      if (!sharp) return; // passthrough responses aren't worth pre-building
      let pipeline = sharp(original.buf, { failOn: "none" }).rotate();
      if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
      const out = await pipeline.webp({ quality: 72 }).toBuffer();

      await ensureImgCacheDir();
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, out);
      await fs.rename(tmp, file);
    } catch {
      /* best effort — /api/img will fetch it live instead */
    } finally {
      warmActive--;
      warmQueue.shift()?.();
    }
  })();

  warming.set(key, task);
  void task.finally(() => warming.delete(key));
}
