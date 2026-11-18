/**
 * City-wide place discovery for the Explore tabs.
 *
 * One Overpass query per category within 25 km of the city centre (widened to
 * 50 km when the pool is thin), then cleaned, scored and paginated on the
 * server: the raw OSM feed (often thousands of elements) never crosses the
 * wire — the client pages through the ranked pool 40 at a time.
 *
 * Ranked "popular first": the score follows the OSM metadata of each element —
 * wikidata/wikipedia identity, website, hotel star classification, a tagged
 * photo, and a real name. Rating-driven terms (Google/Foursquare) plug into
 * `scorePlace` once such data is available.
 *
 * Used by /api/places/city. Pure functions — unit-tested without network.
 */

import { haversineKm } from "./osm";

export type CityCategory =
  | "hotels"
  | "restaurants"
  | "attractions"
  | "experiences"
  | "landmarks"
  | "highlights";

export const CITY_CATEGORIES: readonly CityCategory[] = [
  "hotels",
  "restaurants",
  "attractions",
  "experiences",
  "landmarks",
  "highlights",
];

export function isCityCategory(value: string): value is CityCategory {
  return (CITY_CATEGORIES as readonly string[]).includes(value);
}

/** Overpass tag selectors per category — every clause also requires a name. */
const TAG_FILTERS: Record<CityCategory, string[]> = {
  hotels: [`["tourism"~"^(hotel|guest_house|hostel|apartment|resort|motel)$"]`],
  restaurants: [`["amenity"~"^(restaurant|cafe|fast_food)$"]`],
  attractions: [
    `["tourism"~"^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery)$"]`,
    `["historic"~"^(monument|memorial|castle|ruins|fort|archaeological_site)$"]`,
  ],
  experiences: [
    `["tourism"~"^(theme_park|zoo|aquarium|viewpoint|attraction|artwork)$"]`,
    `["leisure"~"^(park|garden|water_park|nature_reserve)$"]`,
    `["amenity"="marketplace"]`,
  ],
  landmarks: [`["historic"]`, `["tourism"="attraction"]`],
  highlights: [
    `["tourism"~"^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery)$"]`,
    `["historic"~"^(monument|memorial|castle|ruins|fort)$"]`,
  ],
};

export interface Around {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface CityQueries {
  data: string;
  count: string;
}

/** Overpass QL pair: the capped element fetch and the exact total count. */
export function buildCityQueries(
  category: CityCategory,
  around: Around,
  poolCap: number,
  timeoutSec = 60
): CityQueries {
  const clauses = TAG_FILTERS[category]
    .map(
      (f) =>
        `nwr${f}["name"](around:${Math.round(around.radiusKm * 1000)},${around.lat},${around.lng});`
    )
    .join("");
  const union = `(${clauses});`;
  return {
    // `tags center` carries everything we need (node lat/lon, way/relation
    // centers, tags) at a fraction of `body`'s size — the cheaper scan is
    // what keeps this workable on busy public mirrors.
    data: `[out:json][timeout:${timeoutSec}];${union}out tags center ${poolCap};`,
    count: `[out:json][timeout:${timeoutSec}];${union}out count;`,
  };
}

/** Exact element count from an `out count;` payload. */
export function countFromPayload(payload: { elements?: unknown[] } | null): number {
  const first = payload?.elements?.[0] as
    | { tags?: { total?: string; nodes?: string; ways?: string; relations?: string } }
    | undefined;
  const tags = first?.tags;
  if (!tags) return 0;
  const total = Number.parseInt(tags.total ?? "", 10);
  if (Number.isFinite(total)) return total;
  return (
    (Number.parseInt(tags.nodes ?? "", 10) || 0) +
    (Number.parseInt(tags.ways ?? "", 10) || 0) +
    (Number.parseInt(tags.relations ?? "", 10) || 0)
  );
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

export interface CityPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  openState?: string;
  website?: string;
  stars?: number;
  wikidata?: string;
  /** OSM `wikipedia` tag, e.g. "en:Lal Mahal" — the exact article for photos. */
  wikipedia?: string;
  image?: string;
  /** Nominatim's significance (0..1) — ranks fallback results; Overpass has none. */
  importance?: number;
  distanceKm: number;
  score: number;
}

/**
 * Name cleaning (sanitizeText): trims, collapses whitespace, strips control
 * characters; drops empty names and generic web-page titles containing " | ".
 */
export function sanitizeName(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 120) return null;
  if (name.includes(" | ")) return null;
  return name;
}

function firstTag(tags: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = tags[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Overpass elements → cleaned places (named + located only). */
export function collectCityPlaces(elements: unknown[], center: { lat: number; lng: number }): CityPlace[] {
  const out: CityPlace[] = [];
  for (const raw of elements) {
    const el = (raw ?? {}) as OverpassElement;
    const tags = el.tags;
    if (!tags) continue;
    const name = sanitizeName(tags.name);
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!name || typeof lat !== "number" || typeof lng !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const stars = Number.parseFloat(tags.stars ?? "");
    const wikidata = tags.wikidata?.trim();
    const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ").trim();
    out.push({
      id: el.type !== undefined && el.id !== undefined ? `osm:${el.type}/${el.id}` : `osm:${name}`,
      name,
      lat,
      lng,
      address: street || firstTag(tags, ["addr:suburb", "addr:city", "addr:district"]),
      openState: tags.opening_hours?.trim() || undefined,
      website: firstTag(tags, ["website", "contact:website"]),
      stars: Number.isFinite(stars) && stars > 0 && stars <= 5 ? stars : undefined,
      wikidata: wikidata && /^Q\d+$/.test(wikidata) ? wikidata : undefined,
      wikipedia: tags.wikipedia?.trim() || undefined,
      image: firstTag(tags, ["image", "wikimedia_commons"]),
      distanceKm: haversineKm(center, { lat, lng }),
      score: 0,
    });
  }
  return out;
}

/** "Popular first" score from OSM metadata (rating terms slot in later). */
export function scorePlace(p: CityPlace): number {
  let score = 0;
  if (p.wikidata) score += 4;
  if (p.website) score += 2;
  if (p.stars) score += p.stars;
  if (p.image) score += 1.5;
  // Nominatim fallback rows carry importance instead of OSM tags — scaled to
  // sit within the same ~0-13 range so famous landmarks still lead.
  if (p.importance) score += Math.min(p.importance * 10, 5);
  if (p.name.length > 3) score += 0.5;
  return score;
}

/** Lowercased alphanumeric identity for de-duplication (also the fallback id seed). */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Duplicates: same name within 100 m, or the same Wikidata entity — the
 * higher-scored twin wins. Returns the ranked pool (score desc; distance and
 * name break ties so "Popular" is stable).
 */
export function rankCityPlaces(raw: CityPlace[]): CityPlace[] {
  const kept: CityPlace[] = [];
  const wikiIds = new Set<string>();
  /**
   * Same-name candidates bucketed by their normalised name. The old scan
   * compared every place against every kept one (nameKey + haversine each
   * time) — O(n²) on a 600-place city sweep, which is real main-thread time
   * inside the request. A bucket only holds places whose name already
   * matches, so the distance check touches a handful of rows.
   */
  const byName = new Map<string, CityPlace[]>();
  for (const place of raw) {
    place.score = scorePlace(place);
    const wiki = place.wikidata;
    if (wiki) {
      if (wikiIds.has(wiki)) continue;
      wikiIds.add(wiki);
    }
    const key = nameKey(place.name);
    const twins = byName.get(key);
    let twinIndex = -1;
    if (twins) {
      for (let i = 0; i < twins.length; i++) {
        if (haversineKm(twins[i], place) < 0.1) {
          twinIndex = i;
          break;
        }
      }
    }
    if (twinIndex >= 0 && twins) {
      const twin = twins[twinIndex];
      if (place.score <= twin.score) continue;
      const keptIndex = kept.indexOf(twin);
      if (keptIndex >= 0) kept.splice(keptIndex, 1);
      twins.splice(twinIndex, 1);
    }
    kept.push(place);
    if (twins) twins.push(place);
    else byName.set(key, [place]);
  }
  kept.sort(
    (a, b) =>
      b.score - a.score ||
      a.distanceKm - b.distanceKm ||
      a.name.localeCompare(b.name)
  );
  return kept;
}

/** Wire shape for the client — drops tag fields the cards don't render. */
export interface CityPlaceLite {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  openState?: string;
  website?: string;
  stars?: number;
  wikidata?: string;
  osmWikipedia?: string;
  osmImage?: string;
  distanceKm: number;
  /** Image known from the 7-day place-photo memory — renders on first paint. */
  imageUrl?: string;
}

export function toLite(place: CityPlace): CityPlaceLite {
  return {
    id: place.id,
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    address: place.address,
    openState: place.openState,
    website: place.website,
    stars: place.stars,
    wikidata: place.wikidata,
    osmWikipedia: place.wikipedia,
    osmImage: place.image,
    distanceKm: Math.round(place.distanceKm * 10) / 10,
  };
}
