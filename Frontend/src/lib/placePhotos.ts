/**
 * The photo pipeline every place-photo lookup shares.
 *
 * Sources, in order of how well they know a SPECIFIC place:
 *  1. Wikimedia Commons — the place's own article photos (keyless);
 *  2. Openverse — Flickr CC and friends (keyless);
 *  3. Pixabay — the biggest free quota we hold, and the workhorse for card
 *     imagery: it answers "<place> <city>" and "<category> <city>" with real
 *     stock photos, so a place without an article still gets a picture.
 *     Stock is category-accurate, not place-accurate, so galleries opt out of
 *     it via `CollectPhotosOptions.sources`.
 *
 * The three RACE, each with its own budget: a source that is slow (or has
 * nothing for this place) must never hold the whole gallery hostage. The
 * first ones are the place-specific, so their hits lead; Pixabay's stock
 * photos fill the rest.
 *
 * The result is validated by the caller against the place (title/tags), so
 * the order here is "most likely to be this place first", not "all of them
 * are this place".
 */

import {
  commonsImages as sharedCommonsImages,
  openverseImages as sharedOpenverseImages,
} from "./freeImages";
import {
  cooldownPixabayKey,
  pixabayKeyCandidates,
  type PixabaySurface,
} from "@/server/pixabayKeys";
import { pixabayCdnUrl } from "./pixabayCdn";

/** Where a candidate came from — galleries trust place sources over stock. */
export type PhotoCandidateSource = "commons" | "openverse" | "pixabay";

export interface PhotoCandidate {
  url: string;
  /** File name / tags — the caller checks it against the place. */
  title: string;
  source: PhotoCandidateSource;
}

/** Budget for ONE source. */
const SOURCE_MS = 3_500;
/** Pixabay's own per-request budget. */
const PIXABAY_MS = 6_000;

function validUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** A promise that gives up after `ms` — a slow source contributes nothing. */
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

/**
 * Pixabay candidates. The pool rotates past a rate-limited key, and the
 * "detail" surface's key is spent first (the details window owns this).
 */
export async function pixabayPhotoCandidates(
  query: string,
  surface: PixabaySurface = "detail"
): Promise<PhotoCandidate[]> {
  const keys = pixabayKeyCandidates(surface);
  if (keys.length === 0) return [];
  const deadline = Date.now() + PIXABAY_MS;
  for (const key of keys) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const url =
      `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}` +
      `&image_type=photo&orientation=horizontal&safesearch=true&per_page=20`;
    const res = await fetch(url, {
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(Math.max(1000, left)),
    }).catch(() => null);
    if (!res) continue;
    if (res.status === 429 || res.status === 403) {
      cooldownPixabayKey(key);
      continue;
    }
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as {
      hits?: Array<{
        previewURL?: string;
        imageWidth?: number;
        webformatURL?: string;
        largeImageURL?: string;
        tags?: string;
      }>;
    } | null;
    const out: PhotoCandidate[] = [];
    for (const hit of data?.hits ?? []) {
      // The gallery's fullscreen viewer wants the 1280 px rendition. The direct
      // CDN URL is preferred: the `pixabay.com/get/…` hops are per-IP rate
      // limited and fail for whole galleries at a time (see pixabayCdn.ts).
      const u =
        pixabayCdnUrl(hit, 1280) ||
        validUrl(hit?.largeImageURL) ||
        validUrl(hit?.webformatURL);
      if (u) out.push({ url: u, title: hit?.tags ?? "", source: "pixabay" });
    }
    return out;
  }
  return [];
}

/** Commons candidates for a place (1200 px — the gallery's viewer size). */
async function commonsCandidates(query: string): Promise<PhotoCandidate[]> {
  const results = await sharedCommonsImages(query, 1200);
  return results.map((r) => ({ url: r.url, title: r.title, source: "commons" as const }));
}

/**
 * Openverse candidates for a place.
 *
 * Openverse's `url` is the ORIGINAL upload — often an http:// link and
 * sometimes several megabytes, both of which the /api/img proxy rejects or
 * spends the whole budget downloading. Its `thumbnail` is an https,
 * server-side crop, so it is the rendition every surface can actually paint.
 */
async function openverseCandidates(query: string): Promise<PhotoCandidate[]> {
  const results = await sharedOpenverseImages(query);
  return results.flatMap((r) => {
    const url = [r.thumbnail, r.url].find((u) => /^https:\/\//i.test(u ?? ""));
    return url ? [{ url, title: r.title, source: "openverse" as const }] : [];
  });
}

export interface CollectPhotosOptions {
  /** How many photos to return at most. */
  limit?: number;
  /** Which Pixabay key pool to spend first. */
  surface?: PixabaySurface;
  /** Budget for one source. */
  sourceMs?: number;
  /**
   * Which sources to ask. Galleries pass Commons + Openverse only: Pixabay is
   * stock, so it can illustrate the right CATEGORY but never THIS place (a
   * Pune miniature-railway museum ended up with a British Museum interior).
   * Card lookups keep the default because they only need a fitting picture.
   */
  sources?: ReadonlyArray<PhotoCandidateSource>;
  /**
   * Resolve as soon as the settled sources hold at least this many
   * candidates. The gallery doesn't need the slowest source once it already
   * has enough photos — waiting for it only delays the first paint.
   */
  earlyTarget?: number;
}

/**
 * Photo candidates for a place, place-specific sources first. Each source is
 * bounded, so the slowest one can only cost its own budget.
 */
export async function collectPhotoCandidates(
  query: string,
  opts: CollectPhotosOptions = {}
): Promise<PhotoCandidate[]> {
  const sourceMs = opts.sourceMs ?? SOURCE_MS;
  const wanted = new Set<PhotoCandidateSource>(
    opts.sources ?? ["commons", "openverse", "pixabay"]
  );
  const jobs: Array<{
    source: PhotoCandidateSource;
    promise: Promise<PhotoCandidate[] | null>;
  }> = [];
  if (wanted.has("commons")) {
    jobs.push({ source: "commons", promise: withBudget(commonsCandidates(query), sourceMs) });
  }
  if (wanted.has("openverse")) {
    jobs.push({ source: "openverse", promise: withBudget(openverseCandidates(query), sourceMs) });
  }
  if (wanted.has("pixabay")) {
    jobs.push({
      source: "pixabay",
      promise: withBudget(
        pixabayPhotoCandidates(query, opts.surface ?? "detail"),
        sourceMs + 2000
      ),
    });
  }

  const collect = (results: Partial<Record<PhotoCandidateSource, PhotoCandidate[]>>) => [
    ...(results.commons ?? []),
    ...(results.openverse ?? []),
    ...(results.pixabay ?? []),
  ];

  // Fast path: there is no useful head start to gain (or no source to ask).
  if (!opts.earlyTarget || opts.earlyTarget <= 0 || jobs.length === 0) {
    const settled = await Promise.all(jobs.map((job) => job.promise));
    const results: Partial<Record<PhotoCandidateSource, PhotoCandidate[]>> = {};
    jobs.forEach((job, i) => {
      results[job.source] = settled[i] ?? [];
    });
    return collect(results);
  }

  return new Promise((resolve) => {
    const results: Partial<Record<PhotoCandidateSource, PhotoCandidate[]>> = {};
    let settledCount = 0;
    let candidateCount = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(collect(results));
    };
    for (const job of jobs) {
      job.promise.then(
        (list) => {
          results[job.source] = list ?? [];
          settledCount++;
          candidateCount += results[job.source]?.length ?? 0;
          if (candidateCount >= (opts.earlyTarget ?? 0) || settledCount === jobs.length) finish();
        },
        () => {
          settledCount++;
          if (settledCount === jobs.length) finish();
        }
      );
    }
  });
}
