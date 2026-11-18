/**
 * Server-only photo search for one place. Runs on the server so the API keys
 * never reach the browser. The provider implementations live in
 * `placePhotoProviders.ts` (keyed CDNs), `placeWikiProviders.ts` (keyless)
 * and `placeCanonicalProviders.ts` (exact per-place sources) — this file owns
 * the ORDER and the time budget.
 *
 * Order — canonical per-place sources first, fuzzy keyword CDNs last:
 *  1. OSM `image` tag        (exact; tagged on the place; no request)
 *  2–6. the canonical providers race in parallel with priority preference:
 *       Wikidata P18 → Wikipedia article from the OSM `wikipedia` tag →
 *       coordinate-checked Wikipedia search → Commons search → Commons
 *       geosearch (files geotagged within ~300 m, title-verified). An exact
 *       identity answers in ~300 ms; only when everything above a settled
 *       hit has missed does the next provider get the say. The tier is
 *       CAPPED (CANONICAL_CAP_MS): Wikimedia answers in 2–3 s when its cache
 *       is cold, and an uncapped tier would swallow the whole deadline.
 *  7. Google Places          (only when GOOGLE_PLACES_API_KEY is configured)
 *  8. Pexels / Unsplash / Pixabay — LAST resort and only "<city> <category>"
 *                             ("Pune hotel"), never the place name alone;
 *                             results whose own tags name another city's
 *                             landmark are skipped (placeKeywordGuard.ts).
 *                             They RACE each other, so one round trip is
 *                             enough. When the shared "<city> <category>" pool
 *                             runs dry, "<place> <city>" is tried as well.
 *  9. Openverse              (keyless — last resort before the placeholder)
 *
 * Every step shares ONE deadline (DEADLINE_MS): whatever has not answered by
 * then is abandoned, and later steps only get the remaining budget. The
 * keyword tier is RESERVED up front (FALLBACK_RESERVE_MS) — the canonical
 * tier may never borrow it, or a place without a Wikipedia article would
 * show the placeholder while "<city> <category>" had photos waiting.
 * Providers on a rate-limit cooldown are skipped instantly instead of
 * stalling (see placePhotoProviders.ts). Each upstream call additionally
 * rides Next's fetch cache (`next: { revalidate: 86400 }`), so the same place
 * is searched at most once per day even across server restarts.
 *
 * `exclude` keeps the screen duplicate-free: every provider walks past those
 * URLs, so a second place never re-uses a photo that is already displayed.
 *
 * The city: the keyword tiers need one ("<city> <category>"). When the
 * caller has none but the place has coordinates, the reverse geocode runs
 * BESIDE the canonical tier (not before it) and its answer is picked up
 * before the keyword tier starts.
 */

import { cityPhotoQuery, type ImageCategory } from "./placePhotoKey";
import {
  pexelsPhoto,
  pixabayPhoto,
  unsplashPhoto,
  withBudget,
  type PhotoHit,
} from "./placePhotoProviders";
import {
  commonsGeosearchPhoto,
  commonsPhoto,
  openversePhoto,
  wikipediaPhoto,
  wikipediaTagPhoto,
} from "./placeWikiProviders";
import { googlePlacesPhoto, osmTagPhoto, wikidataPhoto } from "./placeCanonicalProviders";
import { contentTokens, reverseGeocode } from "./placeQuery";
import type { PixabaySurface } from "@/server/pixabayKeys";

export type { PhotoHit, PhotoProvider } from "./placePhotoProviders";

const DEADLINE_MS = 3_000;
/**
 * The canonical (Wikipedia / Commons / Wikidata) tier may spend at most this
 * much of the budget. Wikimedia's search endpoints answer in 2–3 s when the
 * cache is cold, so an uncapped tier consumes the whole deadline and the
 * keyword CDNs never run.
 */
const CANONICAL_CAP_MS = 1_400;
/**
 * Budget the keyword tier (Pexels / Unsplash / Pixabay / Openverse) always
 * gets, whatever the canonical tier did. Reserved up front, never borrowed.
 */
const FALLBACK_RESERVE_MS = 1_300;
/**
 * Ceiling for ONE keyword provider. The keyword CDNs race, so this only has
 * to cover a single round trip (a cold Pixabay call takes ~0.6–1 s).
 */
const KEYWORD_STEP_MS = 1_400;
/**
 * Budget the keyword tier keeps back for its second chance (the place's own
 * name) — the shared "<city> <category>" pool runs dry on a big grid.
 */
const NAMED_RESERVE_MS = 500;
/**
 * Reverse geocoding (only when the city is unknown) is capped at this. It
 * is the only way an Explore card without a city name can ever reach the
 * keyword CDNs, so it gets a real slice — but never more than a third of
 * the deadline.
 */
const GEO_BUDGET_MS = 1_000;

/** Remaining budget before the shared deadline (never negative). */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export interface PhotoQuery {
  name: string;
  city: string;
  category: ImageCategory;
  lat?: number;
  lng?: number;
  /** Stable place id (e.g. "osm:node/123") — 7-day cache key upstream. */
  id?: string;
  /** Wikidata entity from OSM, when tagged. */
  wikidata?: string;
  /** OSM `wikipedia` tag ("en:Lal Mahal"), when tagged. */
  wikipedia?: string;
  /** OSM `image` tag (Commons file name), when tagged. */
  imageTag?: string;
  /**
   * Which UI surface asked (explore / trip / detail) — selects that
   * surface's Pixabay key so a busy Explore grid never starves the trip
   * pages or the details window (see server/pixabayKeys.ts).
   */
  surface?: PixabaySurface;
}

export interface FindPlacePhotoOptions {
  /** URLs already used elsewhere on the page — providers walk past them. */
  exclude?: ReadonlySet<string>;
  /** Overrides the default budget (the de-dup fix-up runs on a tighter one). */
  budgetMs?: number;
}

/**
 * Query for the second-chance keyword lookup: the place's own name plus its
 * city. Long OSM names ("Konark Indrayu Enclave internal road, Kondhwa,
 * Pune, …") are trimmed to their first few words — a stock search cannot
 * match an address anyway, and the whole string is just noise.
 */
function namedPhotoQuery(name: string, city: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return "";
  const place = words.join(" ");
  const c = city.trim();
  return c ? `${place} ${c}` : place;
}

/**
 * First provider that answers with a photo wins — a pure race, no priority.
 * Used by the keyword tier: every provider there is asked for the same
 * "<city> <category>" stock photo, so which CDN answers first does not
 * matter, and running them one after another simply multiplied the latency
 * (three sequential round trips could not fit in the reserved budget, which
 * is why the tier was skipped and the placeholder shown).
 *
 * `capMs` bounds the whole tier: a provider that oversteps its own budget
 * can no longer hold the tier past it.
 */
function firstHit(
  providers: Array<Promise<PhotoHit | null>>,
  capMs = Number.POSITIVE_INFINITY
): Promise<PhotoHit | null> {
  if (providers.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settledCount = 0;
    let done = false;
    const finish = (value: PhotoHit | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    if (Number.isFinite(capMs)) {
      const timer = setTimeout(() => finish(null), capMs);
      // The timer must not keep the process alive.
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    }
    for (const provider of providers) {
      provider.then(
        (hit) => {
          settledCount++;
          // A hit wins outright; a miss only ends the race once EVERY
          // provider has answered — a late answer still counts.
          if (hit) finish(hit);
          else if (settledCount === providers.length) finish(null);
        },
        () => {
          settledCount++;
          if (settledCount === providers.length) finish(null);
        }
      );
    }
  });
}

/**
 * Highest-priority answer wins. Waits only for the providers ABOVE the first
 * settled hit — an exact Wikidata image lands in ~300 ms without waiting for
 * the slower keyword-ish searches racing next to it, while a full miss still
 * waits for every provider before falling through to the CDNs.
 *
 * `capMs` is a HARD ceiling: a provider that oversteps its own budget (an
 * unbounded geocode inside a Commons lookup, say) can no longer hold the tier
 * past it — the tier settles as a miss and the reserved keyword budget is
 * still spent on the CDNs.
 */
function firstByPriority(
  providers: Array<Promise<PhotoHit | null>>,
  capMs = Number.POSITIVE_INFINITY
): Promise<PhotoHit | null> {
  if (providers.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const settled: Array<PhotoHit | null | undefined> = new Array(providers.length).fill(undefined);
    let settledCount = 0;
    let done = false;
    const finish = (value: PhotoHit | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const tryResolve = () => {
      for (const value of settled) {
        if (value === undefined) return; // a higher-priority provider is pending
        if (value) {
          finish(value);
          return;
        }
      }
      if (settledCount === providers.length) finish(null);
    };
    if (Number.isFinite(capMs)) {
      const timer = setTimeout(() => finish(null), capMs);
      // The timer must not keep the process alive.
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    }
    providers.forEach((provider, i) => {
      provider.then(
        (hit) => {
          settled[i] = hit;
          settledCount++;
          tryResolve();
        },
        () => {
          settled[i] = null;
          settledCount++;
          tryResolve();
        }
      );
    });
  });
}

/** Search every source for one place. Always settles within the budget. */
export async function findPlacePhoto(
  { name, city, category, lat, lng, wikidata, wikipedia, imageTag, surface }: PhotoQuery,
  opts?: FindPlacePhotoOptions
): Promise<PhotoHit | null> {
  const totalMs = opts?.budgetMs ?? DEADLINE_MS;
  const deadline = Date.now() + totalMs;
  const exclude = opts?.exclude;

  // The city is what the KEYWORD tier needs ("<city> <category>"); the
  // canonical tier can search by name alone (the coordinate check still
  // pins the article to this place). So when the city is unknown the
  // geocode runs BESIDE the canonical tier instead of before it — a
  // Nominatim answer takes 0.5–1.8 s, and waiting for it first used to
  // eat the whole deadline before a single photo was even looked for.
  let cityHint = (city ?? "").trim();
  const geoTask =
    !cityHint && typeof lat === "number" && typeof lng === "number"
      ? reverseGeocode(lat, lng).catch(() => null)
      : null;

  const placeTokens = contentTokens(name);

  // 1: the OSM `image` tag is exact and free — nothing else needs consulting.
  if (imageTag) {
    const tagHit = osmTagPhoto(imageTag, exclude);
    if (tagHit) return tagHit;
  }

  // The canonical tier may only spend the budget the keyword tier does NOT
  // need: Wikimedia answers are slow (a cold article search alone takes
  // ~2 s, and a whole batch of parallel lookups makes it slower still), so
  // without this cap the canonical tier would burn the ENTIRE deadline and
  // the keyword CDNs below would never even be asked — a place with no
  // Wikipedia article then shows the placeholder even though "<city>
  // <category>" has plenty of photos waiting.
  //
  // The reserve is only taken when a keyword query will actually exist: the
  // keyword tiers ask "<city> <category>" and "<place> <city>", so without a
  // city there is nothing for them to search — unless a geocode is in
  // flight, which is exactly the case where a city is about to arrive.
  // It is a share of the budget, so the tighter de-dupe fix-up budget is
  // not swallowed whole by the reserve.
  const keywordReserve =
    cityHint || geoTask ? Math.min(FALLBACK_RESERVE_MS, Math.floor(totalMs * 0.45)) : 0;
  const canonicalBudget = Math.max(
    0,
    Math.min(CANONICAL_CAP_MS, remaining(deadline) - keywordReserve)
  );

  // 2–6: canonical providers, raced with priority preference (array order =
  // priority). An exact identity answers fast while the slower searches keep
  // running in the background; the first hit at the highest settled priority
  // wins, and a full miss falls through to the keyword CDNs below.
  const canonical: Array<Promise<PhotoHit | null>> = [];
  if (wikidata) canonical.push(wikidataPhoto(wikidata, canonicalBudget, exclude));
  if (wikipedia) {
    canonical.push(wikipediaTagPhoto(wikipedia, lat, lng, canonicalBudget, exclude));
  }
  canonical.push(
    wikipediaPhoto(name.trim(), cityHint, placeTokens, canonicalBudget, exclude, { lat, lng })
  );
  canonical.push(commonsPhoto(name.trim(), cityHint, lat, lng, canonicalBudget, exclude));
  if (typeof lat === "number" && typeof lng === "number") {
    canonical.push(commonsGeosearchPhoto(lat, lng, placeTokens, canonicalBudget, exclude));
  }
  const canonicalHit = await firstByPriority(canonical, canonicalBudget);
  if (canonicalHit) return canonicalHit;

  // The geocode has been running beside the canonical tier all along — take
  // its answer now, if it landed in time. It is the only way an Explore card
  // without a city name can reach the keyword CDNs at all.
  if (!cityHint && geoTask) {
    const geo = await withBudget(geoTask, Math.min(GEO_BUDGET_MS, remaining(deadline)));
    cityHint = geo?.city?.trim() ?? "";
  }
  const broad = cityPhotoQuery(category, cityHint);
  const cityTokens = contentTokens(cityHint);

  // 7: Google Places — without GOOGLE_PLACES_API_KEY this settles instantly.
  const googleHit = await googlePlacesPhoto(name.trim(), cityHint, lat, lng, remaining(deadline));
  if (googleHit) return googleHit;

  // 8: keyword CDNs — city + category ONLY (never the place name alone), and
  // every result is guarded against other-city landmarks. They RACE: they
  // all answer the same "<city> <category>" question, so running them one
  // after another only multiplied the latency — three sequential round trips
  // could not fit in the reserved budget, the tier was skipped, and the card
  // fell back to the placeholder while a perfectly good stock photo waited.
  //
  // The race gets part of the keyword budget and leaves the rest for the
  // second chance below: a race that misses waits for its whole budget, and
  // a first chance that spends ALL of it would leave the second one nothing.
  const keywordTotal = Math.min(KEYWORD_STEP_MS, remaining(deadline));
  const broadBudget = Math.max(
    200,
    Math.min(1000, keywordTotal - NAMED_RESERVE_MS, remaining(deadline))
  );
  const keyword: Array<Promise<PhotoHit | null>> = [];
  if (broad) {
    keyword.push(pexelsPhoto(broad, broadBudget, exclude, cityHint));
    keyword.push(unsplashPhoto(broad, broadBudget, exclude, cityHint));
    keyword.push(pixabayPhoto(broad, broadBudget, exclude, cityHint, surface));
  }
  // 9: keyless Openverse — last resort before the placeholder. It is asked
  // with the PLACE NAME (not city + category) and is slower than the CDNs,
  // so it races them from behind: whichever answers first wins.
  keyword.push(
    openversePhoto(name.trim(), cityHint, placeTokens, cityTokens, broadBudget, exclude)
  );
  const keywordHit = await firstHit(keyword, broadBudget);
  if (keywordHit) return keywordHit;

  // 10: second chance, the place's OWN name. The shared "<city> <category>"
  // pool is finite (a stock query returns ~20 photos) and every card of a
  // city asks for the same one — a grid of 30 cards drains it after ~20
  // and the rest fell back to the placeholder even though a photo OF THE
  // PLACE exists. Only the cards the pool could not serve reach this, and
  // the same other-city guard still applies.
  //
  // The city stays in the query: the place name alone is exactly what the
  // keyword tier must never ask for, and without a city the other-city
  // guard cannot run either. No city → no second chance.
  const named = cityHint ? namedPhotoQuery(name, cityHint) : "";
  if (named) {
    const namedBudget = Math.min(KEYWORD_STEP_MS, remaining(deadline));
    const namedHits: Array<Promise<PhotoHit | null>> = [
      pexelsPhoto(named, namedBudget, exclude, cityHint),
      unsplashPhoto(named, namedBudget, exclude, cityHint),
      pixabayPhoto(named, namedBudget, exclude, cityHint, surface),
    ];
    const namedHit = await firstHit(namedHits, remaining(deadline));
    if (namedHit) return namedHit;
  }
  return null;
}
