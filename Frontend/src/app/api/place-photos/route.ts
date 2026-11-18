import { NextRequest } from "next/server";
import { contentTokens, resolvePlaceContext, titleMentions } from "@/lib/placeQuery";
import { collectPhotoCandidates } from "@/lib/placePhotos";
import { warmImgCache } from "@/server/imgCache";
import { dropUnreachable } from "@/server/reachableImages";

export const runtime = "nodejs";

/**
 * Place photo gallery resolver (free-first).
 *
 * Sources: Wikimedia Commons + Openverse (keyless, they know the place) and
 * Pixabay (the big free quota, and the workhorse for a place without an
 * article) — they race, each with its own budget. The user's RapidAPI
 * Google Images key tops up when they fall short.
 *
 * Results are cached in memory; concurrent requests for the same place share
 * one lookup (a reopened details window never doubles the upstream work).
 */

const RAPID_HOST = process.env.RAPIDAPI_IMAGES_HOST?.trim();
const RAPID_KEY = process.env.RAPIDAPI_IMAGES_KEY?.trim();

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 500;
const FREE_TARGET = 12;
const MIN_WIDTH = 500;
/**
 * Budget for ONE source. Wikimedia answers in ~1 s, Openverse regularly
 * takes 7 s and often has nothing for a specific landmark — the gallery
 * used to wait for the slowest of them, so a photo set that was ready in
 * one second arrived seven seconds later.
 */
const FREE_SOURCE_MS = 2_500;
/** The metered top-ups are the last resort; they must not hold the answer. */
const METERED_SOURCE_MS = 4_000;
/**
 * A gallery request that arrives without a city would otherwise wait for a
 * reverse geocode (up to 6 s) before it even starts looking for photos. The
 * city only sharpens the query; after this budget the name alone is enough.
 */
const CONTEXT_BUDGET_MS = 1_000;
/** How many of the first gallery renditions to build before the browser asks. */
const WARM_GALLERY_PHOTOS = 6;
const WARM_GALLERY_WIDTH = 640;

const cache = new Map<string, { at: number; photos: string[] }>();
/** In-flight lookups by cache key — a second request awaits the first. */
const inflight = new Map<string, Promise<string[]>>();

function validUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim();
  // /api/img only proxies https (see isSafeRemote), so an http candidate would
  // be a guaranteed 404 on every surface. Drop it before it takes a slot.
  return /^https:\/\//i.test(s) ? s : null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pushUnique(out: string[], seen: Set<string>, url: unknown): void {
  const u = validUrl(url);
  if (!u || seen.has(u)) return;
  seen.add(u);
  out.push(u);
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 7000): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const outer = init?.signal;
  const signal = outer ? AbortSignal.any([timeout, outer]) : timeout;
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

/**
 * A promise that gives up after `ms` — the source that has not answered by
 * then simply contributes nothing. A slow upstream must never delay the
 * whole gallery.
 */
function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
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

/** Top-up: RapidAPI Google Images (user key), gallery-quality only. */
async function rapidImageUrls(q: string, signal?: AbortSignal): Promise<string[]> {
  if (!RAPID_HOST || !RAPID_KEY) return [];
  try {
    const url =
      `https://${RAPID_HOST}/getGoogleImages` +
      `?query=${encodeURIComponent(q)}&count=16&imageInfo=true`;
    const data = (await fetchJson(url, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": RAPID_HOST,
        "x-rapidapi-key": RAPID_KEY,
      },
      signal,
    })) as { images?: Array<{ url?: string; width?: number; height?: number }> };
    const out: string[] = [];
    for (const img of data?.images ?? []) {
      const w = typeof img.width === "number" ? img.width : 0;
      const h = typeof img.height === "number" ? img.height : 0;
      if (w && w < MIN_WIDTH) continue;
      if (h && h < 350) continue;
      const u = validUrl(img.url);
      if (u) out.push(u);
    }
    return out;
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const q = String(body?.name ?? "").trim();
    if (!q) return Response.json({ error: "name required" }, { status: 400 });

    const la = typeof body?.lat === "number" ? body.lat : parseFloat(String(body?.lat ?? ""));
    const lo = typeof body?.lng === "number" ? body.lng : parseFloat(String(body?.lng ?? ""));
    const hasCoords = Number.isFinite(la) && Number.isFinite(lo);
    const limit = typeof body?.count === "number" ? Math.min(Math.max(body.count, 1), 24) : 12;

    const suppliedCity = typeof body?.city === "string" ? body.city.trim() : "";
    const suppliedCountry = typeof body?.country === "string" ? body.country.trim() : "";

    // Full search context: "{place} {city} {country}" (reverse-geocoded when
    // the caller only knows coordinates) so "Le Marais" can't match a wetland.
    // The geocode is bounded: a gallery that already knows the place name must
    // not spend six seconds waiting for a city hint before it searches.
    const resolved = await withBudget(
      resolvePlaceContext({
        name: q,
        lat: hasCoords ? la : undefined,
        lng: hasCoords ? lo : undefined,
        city: suppliedCity || undefined,
        country: suppliedCountry || undefined,
      }),
      CONTEXT_BUDGET_MS
    );
    const ctx = resolved ?? {
      city: suppliedCity || null,
      country: suppliedCountry || null,
      query: q,
      placeTokens: contentTokens(q),
      cityTokens: new Set<string>(),
    };
    const fullQ = ctx.query;

    const cacheKey = `${norm(fullQ)}|${hasCoords ? `${la.toFixed(3)},${lo.toFixed(3)}` : ""}|${limit}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return Response.json({ photos: hit.photos });
    }
    // Two components asking for the same place at once (details + map card)
    // share one lookup instead of doubling every upstream call.
    const pending = inflight.get(cacheKey);
    if (pending) return Response.json({ photos: await pending });

    const task = (async () => {
      const out: string[] = [];
      const seen = new Set<string>();

      // The metered top-up starts NOW, beside the free sources. Waiting for
      // the free sources first meant paying their budget and RapidAPI's
      // four seconds back-to-back on a place they could not cover.
      const rapidAbort = new AbortController();
      const rapidTask = withBudget(
        rapidImageUrls(fullQ, rapidAbort.signal),
        METERED_SOURCE_MS
      );

      // 1) The sources RACE (see src/lib/placePhotos.ts): Wikimedia Commons
      //    and Openverse know the place best, Pixabay has the quota and the
      //    reach. Waiting for them one after another only added their
      //    latencies together, and a source that has nothing for this place
      //    must not hold the whole gallery hostage.
      const candidates = await collectPhotoCandidates(fullQ, {
        limit: limit + 8,
        surface: "detail",
        sourceMs: FREE_SOURCE_MS,
        // Enough already? Don't wait for the slowest source to finish its
        // full budget just to add photos behind the ones we will show.
        earlyTarget: limit,
        // Gallery only: Commons/Openverse actually search THIS place. Pixabay
        // stock answered the category instead, which is how a British Museum
        // interior ended up in a Pune miniature-railway museum's gallery.
        sources: ["commons", "openverse"],
      });

      // Validated matches first so a same-named place elsewhere never wins
      // over the real one. Unmatched titles stay behind them: both sources
      // searched this place's own name, so a file name that merely omits it
      // is still a photo from that search.
      const validated = candidates.filter((c) => titleMentions(c.title, ctx));
      const rejected = candidates.length - validated.length;
      for (const c of [...validated, ...candidates.filter((c) => !titleMentions(c.title, ctx))]) {
        pushUnique(out, seen, c.url);
      }

      // 2) Use the top-up only when the free sources came up short. If they
      //    were enough, abort the in-flight metered call instead of spending
      //    the user's quota for photos that would be sliced off anyway.
      let rapidCount = 0;
      if (out.length >= FREE_TARGET) {
        rapidAbort.abort();
      } else {
        const before = out.length;
        for (const u of (await rapidTask) ?? []) {
          pushUnique(out, seen, u);
          if (out.length >= FREE_TARGET + 4) break;
        }
        rapidCount = out.length - before;
      }

      console.info(
        `[place-photos] "${q}" city="${ctx.city ?? "?"}${ctx.country ? ` ${ctx.country}` : ""}"` +
          ` → ${out.length} (candidates ${candidates.length}: validated ${validated.length},` +
          ` rejected ${rejected}; rapid ${rapidCount})`
      );

      const photos = (await dropUnreachable(out.slice(0, limit + 4))).slice(0, limit);

      // The gallery's first row asks /api/img the moment this JSON lands.
      // Build those renditions now, at the tile width, so the cold upstream
      // fetch + sharp resize is already done by the time the browser asks.
      for (const url of photos.slice(0, WARM_GALLERY_PHOTOS)) {
        warmImgCache(url, WARM_GALLERY_WIDTH);
      }

      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(cacheKey, { at: Date.now(), photos });
      return photos;
    })();

    inflight.set(cacheKey, task);
    try {
      return Response.json({ photos: await task });
    } finally {
      inflight.delete(cacheKey);
    }
  } catch (err) {
    console.error("Place photos error:", err);
    return Response.json({ photos: [] });
  }
}
