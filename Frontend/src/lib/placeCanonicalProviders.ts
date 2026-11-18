/**
 * Exact per-place photo sources, checked BEFORE any keyword search:
 *
 *  - the OSM `image` tag (a Wikimedia Commons file name tagged directly on
 *    the place — no network needed),
 *  - the place's Wikidata entity (`P18` image claim),
 *  - Google Places, opt-in via GOOGLE_PLACES_API_KEY. The photo bytes are
 *    fetched server-side through `/api/img?gphoto=…`, so the API key never
 *    leaks into the page.
 *
 * All server-only; they return null on a miss so the chain falls through.
 */

import { fetchJson, photoId, type PhotoHit } from "./placePhotoProviders";
import { commonsFileFromTag, commonsFilePathUrl } from "./commonsFile";

export { commonsFileFromTag, commonsFilePathUrl };

/** OSM `image` tag → photo. Instant; no request. */
export function osmTagPhoto(tag: unknown, exclude?: ReadonlySet<string>): PhotoHit | null {
  const file = commonsFileFromTag(tag);
  if (!file) return null;
  const image = commonsFilePathUrl(file);
  if (exclude?.has(photoId(image))) return null;
  return { image, source: "osm" };
}

interface WikidataClaims {
  claims?: Record<
    string,
    Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>
  >;
}

/** Wikidata entity P18 (image) → photo on Commons. */
export async function wikidataPhoto(
  qid: string | undefined,
  budgetMs: number,
  exclude?: ReadonlySet<string>
): Promise<PhotoHit | null> {
  if (!qid || !/^Q\d+$/.test(qid) || budgetMs <= 0) return null;
  const res = await fetchJson(
    `https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P18&entity=${qid}`,
    {},
    budgetMs
  );
  if (!res || res.status !== 200) return null;
  const claims = (res.data as WikidataClaims | null)?.claims?.P18 ?? [];
  for (const claim of claims) {
    const file = claim?.mainsnak?.datavalue?.value;
    if (typeof file !== "string") continue;
    // P18 values look like "File:Lal Mahal.jpg" — same cleaning as OSM tags.
    const clean = commonsFileFromTag(file);
    if (!clean) continue;
    const image = commonsFilePathUrl(clean);
    if (!exclude?.has(photoId(image))) return { image, source: "wikidata" };
  }
  return null;
}

interface GoogleSearchResponse {
  places?: Array<{ photos?: Array<{ name?: string }> }>;
}

/**
 * Google Places (New) text search → first photo, referenced through
 * `/api/img?gphoto=…` so the browser never sees GOOGLE_PLACES_API_KEY. The
 * full media URL (with the key) is built server-side in the img route. No key
 * → instant no-op, and the rest of the chain carries on.
 */
export async function googlePlacesPhoto(
  name: string,
  city: string,
  lat: number | undefined,
  lng: number | undefined,
  budgetMs: number
): Promise<PhotoHit | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key || !name || budgetMs <= 0) return null;
  const body: Record<string, unknown> = {
    textQuery: [name, city].filter(Boolean).join(" "),
    maxResultCount: 1,
  };
  if (typeof lat === "number" && typeof lng === "number") {
    body.locationBias = {
      circle: { center: { latitude: lat, longitude: lng }, radius: 5000 },
    };
  }
  const res = await fetchJson(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.photos",
      },
      body: JSON.stringify(body),
    },
    budgetMs
  );
  if (!res || res.status !== 200) return null;
  const photoName = (res.data as GoogleSearchResponse | null)?.places?.[0]?.photos?.[0]?.name;
  if (typeof photoName !== "string" || !photoName.startsWith("places/")) return null;
  // Local proxy ref — the img route appends the key server-side.
  return { image: `/api/img?gphoto=${encodeURIComponent(photoName)}`, source: "google" };
}
