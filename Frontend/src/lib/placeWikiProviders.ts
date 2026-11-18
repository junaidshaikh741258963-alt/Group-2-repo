/**
 * Server-only KEYLESS photo providers — Wikipedia's article photo, Wikimedia
 * Commons and Openverse — the safety net that keeps the app fully working
 * with no API keys at all. The keyed CDN providers live in
 * `placePhotoProviders.ts`; the chain order and its shared deadline live in
 * `placePhotoSearch.ts`.
 *
 * Every provider accepts an `exclude` set (URLs already shown elsewhere on
 * the page) and walks past those candidates — returning null lets the next
 * source try instead of repeating a photo the user already sees.
 */

import { commonsImages, openverseImages } from "./freeImages";
import {
  cdnUrl,
  fetchJson,
  httpsUrl,
  photoId,
  withBudget,
  type PhotoHit,
} from "./placePhotoProviders";
import { haversineKm } from "./osm";
import { contentTokens, resolvePlaceContext, titleMentions } from "./placeQuery";

/**
 * Wikimedia serves originals from upload.wikimedia.org and scaled thumbnails
 * from thumb.wikimedia.org (their newer media CDN) — both are legit.
 */
const COMMONS_HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org"];

function commonsUrl(value: unknown): string | null {
  for (const host of COMMONS_HOSTS) {
    const url = cdnUrl(value, host);
    if (url) return url;
  }
  return null;
}

interface WikipediaPage {
  title?: string;
  index?: number;
  thumbnail?: { source?: string; width?: number; height?: number };
  coordinates?: Array<{ lat?: number; lon?: number }>;
}

interface WikipediaResponse {
  query?: {
    pages?: Record<string, WikipediaPage>;
  };
}

/** The article's coordinates must be within this radius of the place when both are known. */
const MAX_COORD_KM = 5;

/**
 * Rejects an article whose own coordinates sit far from the place — the Taj
 * Mahal article must never illustrate Pune's Lal Mahal even if the title
 * superficially matches. Articles without coordinates fall back to the
 * title-token score alone.
 */
function pageTooFar(
  page: WikipediaPage,
  lat: number | undefined,
  lng: number | undefined
): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  const coord = page.coordinates?.[0];
  if (typeof coord?.lat !== "number" || typeof coord?.lon !== "number") return false;
  return haversineKm({ lat, lng }, { lat: coord.lat, lng: coord.lon }) > MAX_COORD_KM;
}

/**
 * Radius for accepting an article purely on its location. Much tighter than
 * MAX_COORD_KM: here the coordinates are the ONLY thing linking the article
 * to the place, so they have to mean the same building.
 */
const ON_PLACE_KM = 1.5;

/**
 * True when the article's own coordinates sit ON the place (a few hundred
 * metres) and its title still mentions the place's own words. Both are
 * needed: the coordinates prove the article is about this spot, the words
 * prove the article is about this place.
 *
 * The place must have at least two words: a one-word name ("Hotel",
 * "Museum") is a type, not a name, and would match whatever happens to be
 * within a kilometre of it.
 */
function articleIsOnPlace(
  page: WikipediaPage,
  placeTokens: Set<string>,
  lat: number | undefined,
  lng: number | undefined
): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (placeTokens.size < 2) return false;
  const coord = page.coordinates?.[0];
  if (typeof coord?.lat !== "number" || typeof coord?.lon !== "number") return false;
  if (haversineKm({ lat, lng }, { lat: coord.lat, lng: coord.lon }) > ON_PLACE_KM) {
    return false;
  }
  if (!page.title) return false;
  const titleTokens = contentTokens(page.title);
  // Every word of the place's name must be in the article's title.
  for (const t of placeTokens) {
    if (!titleTokens.has(t)) return false;
  }
  return true;
}

/**
 * Type words ("hotel", "museum", "temple"…) barely discriminate — a title
 * matching only one of these must not count as the place's article.
 */
const GENERIC_TOKENS = new Set([
  "airport",
  "aquarium",
  "arena",
  "avenue",
  "bar",
  "basilica",
  "baths",
  "beach",
  "boulevard",
  "bridge",
  "building",
  "cafe",
  "castle",
  "cathedral",
  "central",
  "chapel",
  "church",
  "city",
  "college",
  "district",
  "fort",
  "fortress",
  "fountain",
  "gallery",
  "garden",
  "gardens",
  "gate",
  "grand",
  "great",
  "harbor",
  "harbour",
  "historic",
  "hostel",
  "hotel",
  "house",
  "inn",
  "island",
  "jardin",
  "lake",
  "library",
  "main",
  "mall",
  "market",
  "memorial",
  "monument",
  "mosque",
  "motel",
  "mountain",
  "museum",
  "national",
  "new",
  "old",
  "opera",
  "palace",
  "park",
  "piazza",
  "plaza",
  "port",
  "quarter",
  "resort",
  "restaurant",
  "river",
  "road",
  "royal",
  "rue",
  "saint",
  "sainte",
  "san",
  "santa",
  "sea",
  "square",
  "stadium",
  "station",
  "statue",
  "street",
  "synagogue",
  "temple",
  "theater",
  "theatre",
  "tower",
  "town",
  "university",
  "villa",
  "village",
  "zoo",
]);

/**
 * Distinctive-token score for a candidate article title; -1 = no real match.
 *
 * `placeTokens` are the place's own words, `cityTokens` the city's. A title
 * that shares a DISTINCTIVE word with the place scores highest. A title
 * whose every remaining word is already known (place or city) is the place's
 * own article written with a disambiguator — "National Museum, New Delhi"
 * for the place "National Museum" — and counts as a match even though every
 * word of the place's name is a generic type word ("national", "museum").
 * A title with no distinctive word of its own (the bare article "Hotel") is
 * still rejected: it says nothing about this place.
 */
function wikiTitleScore(
  title: string | undefined,
  placeTokens: Set<string>,
  cityTokens: ReadonlySet<string> = new Set()
): number {
  if (!title) return -1;
  let distinctive = 0;
  let total = 0;
  const titleTokens = contentTokens(title);
  for (const t of titleTokens) {
    if (!placeTokens.has(t)) continue;
    total++;
    if (!GENERIC_TOKENS.has(t)) distinctive++;
  }
  if (distinctive > 0) return distinctive * 10 + total;

  // No distinctive shared word — accept only an exact-name article: every
  // non-generic word of the title must be one the place (or its city) is
  // already known by, and there must be at least one such word.
  const known = new Set([...placeTokens, ...cityTokens]);
  const titleSpecific = [...titleTokens].filter((t) => !GENERIC_TOKENS.has(t));
  if (titleSpecific.length === 0) return -1;
  if (!titleSpecific.every((t) => known.has(t))) return -1;
  if (!titleSpecific.some((t) => known.has(t))) return -1;
  // The article must still be about THIS place: its name words have to
  // appear in the title.
  if (![...placeTokens].some((t) => titleTokens.has(t))) return -1;
  return 5 + total;
}

/**
 * Keyless source #1: the photo from the place's Wikipedia article (infobox
 * image) — usually the canonical picture of the spot. Search + page image +
 * coordinates in one API call; no key and no practical quota. Only articles
 * sharing a distinctive word with the place name AND (when both sides have
 * coordinates) sitting within 5 km of the place are accepted — better no
 * photo than the wrong photo.
 */
export async function wikipediaPhoto(
  name: string,
  city: string,
  placeTokens: Set<string>,
  budgetMs: number,
  exclude?: ReadonlySet<string>,
  coords?: { lat?: number; lng?: number }
): Promise<PhotoHit | null> {
  if (!name || budgetMs <= 0) return null;
  const query = [name, city].filter(Boolean).join(" ");
  const res = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=4` +
      `&prop=pageimages|coordinates&piprop=thumbnail&pithumbsize=500&redirects=1&colimit=1`,
    {},
    budgetMs
  );
  const data = res && res.status === 200 ? (res.data as WikipediaResponse) : null;
  const cityTokens = contentTokens(city);
  const pages = Object.values(data?.query?.pages ?? {});
  const ranked = pages
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
    .map((page) => ({ page, score: wikiTitleScore(page.title, placeTokens, cityTokens) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { page } of ranked) {
    if (pageTooFar(page, coords?.lat, coords?.lng)) continue;
    const t = page.thumbnail;
    // Skip likely icons/logos when the API reported dimensions.
    if (typeof t?.source !== "string" || (t.width !== undefined && t.width < 300)) continue;
    const image = commonsUrl(t.source);
    if (image && !exclude?.has(photoId(image))) return { image, source: "wikipedia" };
  }
  // Second pass: a place whose name is made only of generic words ("National
  // Museum") shares no distinctive word with its article ("National Museum
  // of India"), so the score above rejects it. The coordinates settle it —
  // the article's own location sits on the place, and its title still names
  // the place's kind of thing.
  for (const page of pages) {
    if (ranked.some((c) => c.page === page)) continue;
    if (!articleIsOnPlace(page, placeTokens, coords?.lat, coords?.lng)) continue;
    const t = page.thumbnail;
    if (typeof t?.source !== "string" || (t.width !== undefined && t.width < 300)) continue;
    const image = commonsUrl(t.source);
    if (image && !exclude?.has(photoId(image))) return { image, source: "wikipedia" };
  }
  return null;
}

/**
 * Exact article via the OSM `wikipedia` tag (e.g. "en:Lal Mahal") — no search
 * guesswork at all; coordinate-checked like the search path. The language
 * prefix is validated before it becomes a hostname.
 */
export async function wikipediaTagPhoto(
  tag: string | undefined,
  lat: number | undefined,
  lng: number | undefined,
  budgetMs: number,
  exclude?: ReadonlySet<string>
): Promise<PhotoHit | null> {
  if (!tag || budgetMs <= 0) return null;
  const match = tag.trim().match(/^([a-z-]{2,12}):(.+)$/i);
  const lang = (match ? match[1] : "en").toLowerCase();
  const title = (match ? match[2] : tag).trim();
  if (!/^[a-z-]{2,12}$/.test(lang) || !title) return null;
  const res = await fetchJson(
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&titles=${encodeURIComponent(title)}&prop=pageimages|coordinates` +
      `&piprop=thumbnail&pithumbsize=500&redirects=1&colimit=1`,
    {},
    budgetMs
  );
  const data = res && res.status === 200 ? (res.data as WikipediaResponse) : null;
  for (const page of Object.values(data?.query?.pages ?? {})) {
    if (pageTooFar(page, lat, lng)) continue;
    const t = page.thumbnail;
    if (typeof t?.source !== "string" || (t.width !== undefined && t.width < 300)) continue;
    const image = commonsUrl(t.source);
    if (image && !exclude?.has(photoId(image))) return { image, source: "wikipedia" };
  }
  return null;
}

/** Keyless: Wikimedia Commons, validated against the place name. */
export async function commonsPhoto(
  name: string,
  city: string,
  lat: number | undefined,
  lng: number | undefined,
  budgetMs: number,
  exclude?: ReadonlySet<string>
): Promise<PhotoHit | null> {
  if (budgetMs <= 0) return null;
  // commonsImages carries its own 7 s timeout — race it against our budget.
  const results = await withBudget(commonsImages([name, city].filter(Boolean).join(" ")), budgetMs);
  if (!results || results.length === 0) return null;
  // The context is only needed to VALIDATE the titles. Resolving it must
  // never outlast the budget: an unbounded geocode here used to hold the
  // whole canonical tier past its deadline (Nominatim answers in 1–6 s and
  // rate-limits parallel callers, so a batch of eight lookups all stalled
  // on it at once). Bounded — and skipped entirely when the city is known.
  const ctx = await withBudget(
    resolvePlaceContext({ name, lat, lng, city: city || undefined }),
    Math.max(0, budgetMs - 250)
  );
  if (!ctx) return null;
  const ranked = [
    ...results.filter((r) => titleMentions(r.title, ctx)),
    ...results.filter((r) =>
      titleMentions(r.title, { placeTokens: ctx.placeTokens, cityTokens: new Set() })
    ),
    ...results,
  ];
  for (const r of ranked) {
    const image = commonsUrl(r.thumbnail || r.url);
    if (image && !exclude?.has(photoId(image))) return { image, source: "commons" };
  }
  return null;
}

interface CommonsGeoPage {
  title?: string;
  imageinfo?: Array<{ thumburl?: unknown; url?: unknown; width?: number }>;
}

/**
 * Keyless location-exact source: Commons files geotagged within ~300 m of the
 * place. The API's generator form reports no per-file distances, so acceptance
 * is strict — the file's own title must share a DISTINCTIVE word with the
 * place name (wikiTitleScore, generic words like "hotel" do not count):
 * "File:Shaniwar Wada, Pune.jpg" qualifies; a flower macro or a different
 * hotel geotagged on the same street does not. Better no photo than a
 * neighbor's.
 */
export async function commonsGeosearchPhoto(
  lat: number,
  lng: number,
  placeTokens: Set<string>,
  budgetMs: number,
  exclude?: ReadonlySet<string>
): Promise<PhotoHit | null> {
  if (budgetMs <= 0 || placeTokens.size === 0) return null;
  const res = await fetchJson(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
      `&generator=geosearch&ggscoord=${lat}|${lng}&ggsradius=300&ggslimit=8&ggsnamespace=6` +
      `&prop=imageinfo&iiprop=url|size&iiurlwidth=500`,
    {},
    budgetMs
  );
  const data =
    res && res.status === 200
      ? (res.data as { query?: { pages?: Record<string, CommonsGeoPage> } })
      : null;
  for (const page of Object.values(data?.query?.pages ?? {})) {
    if (!page.title || /\.svg$/i.test(page.title)) continue;
    if (wikiTitleScore(page.title, placeTokens) <= 0) continue;
    const info = page.imageinfo?.[0];
    if (typeof info?.width === "number" && info.width < 300) continue;
    const image = commonsUrl(info?.thumburl || info?.url);
    if (image && !exclude?.has(photoId(image))) return { image, source: "commons" };
  }
  return null;
}

/** Keyless: Openverse (Flickr CC etc.) — last resort before the placeholder. */
export async function openversePhoto(
  name: string,
  city: string,
  placeTokens: Set<string>,
  cityTokens: Set<string>,
  budgetMs: number,
  exclude?: ReadonlySet<string>
): Promise<PhotoHit | null> {
  if (!name || budgetMs <= 0) return null;
  const results = await withBudget(
    openverseImages([name, city].filter(Boolean).join(" ")),
    budgetMs
  );
  if (!results || results.length === 0) return null;
  const ranked = [
    ...results.filter((r) => titleMentions(r.title, { placeTokens, cityTokens })),
    ...results,
  ];
  for (const r of ranked) {
    const image = httpsUrl(r.thumbnail || r.url);
    if (image && !exclude?.has(photoId(image))) return { image, source: "openverse" };
  }
  return null;
}
