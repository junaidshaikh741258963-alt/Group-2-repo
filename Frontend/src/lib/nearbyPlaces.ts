/**
 * Pure helpers for the "Nearby & suggestions" cards. Kept out of the route so
 * the ranking / image-hint mapping can be tested without a network.
 */

import { commonsFileFromTag, commonsFilePathUrl } from "@/lib/commonsFile";
import { haversineKm, type OsmPoint } from "@/lib/osm";

export interface NearbyPlace {
  /** Stable OSM identity ("osm:node/123") — enables the 7-day image cache. */
  id?: string;
  name: string;
  rating?: number;
  reviews?: number;
  type?: string;
  price?: string;
  openState?: string;
  address?: string;
  /** Instant photo when the place carries an OSM image tag. */
  thumbnail?: string;
  imageUrl?: string;
  lat?: number;
  lng?: number;
  link?: string;
  /** Address city — sharpens the image lookup without a reverse geocode. */
  city?: string;
  /** Exact photo identity from OSM / Nominatim extratags. */
  wikidata?: string;
  osmWikipedia?: string;
  osmImage?: string;
  distanceKm?: number;
}

/**
 * Search radius per category. Restaurants and cafes are dense, so 2 km keeps
 * the list walkable; attractions and shopping are sparse and travellers
 * happily go a little further. At a flat 2 km the Attractions / Things-to-do
 * tabs came back EMPTY in a city like Jaipur even though Hawa Mahal and
 * Jantar Mantar were only ~4 km away.
 */
export function radiusKmForQuery(query: string): number {
  const q = query.toLowerCase();
  // "coffee shop" contains "shop" but is a cafe, not a retail category.
  if (/cafe|coffee|tea house/.test(q)) return 2;
  if (/shop|shopping|mall|market|store/.test(q)) return 4;
  if (/restaurant|food|eat|meal|bar|pub|bakery|brunch/.test(q)) return 2;
  if (/hotel|stay|lodging|hostel|resort|accommodation/.test(q)) return 4;
  if (/attraction|things to do|sight|museum|landmark|monument|park|viewpoint|tour/.test(q)) {
    return 5;
  }
  // Free-text searches ("pizza", "taj mahal", …) need a little room too.
  return 5;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** One OSM/Nominatim row → the card shape, with every image hint preserved. */
export function nearbyPlaceFrom(p: OsmPoint, center: { lat: number; lng: number }): NearbyPlace {
  const file = commonsFileFromTag(p.imageTag);
  const directImage =
    !file && p.imageTag && /^https?:\/\//i.test(p.imageTag) ? p.imageTag : undefined;
  const hasOsmId =
    (p.osmType === "node" || p.osmType === "way" || p.osmType === "relation") &&
    typeof p.osmId === "number";
  return {
    id: hasOsmId ? `osm:${p.osmType}/${p.osmId}` : undefined,
    name: p.name,
    type: p.category,
    address: p.address,
    openState: p.openingHours,
    lat: p.lat,
    lng: p.lng,
    link: p.website,
    city: p.city,
    wikidata: p.wikidata,
    osmWikipedia: p.wikipedia,
    osmImage: p.imageTag,
    // A tagged Commons file is known exactly — the card can paint it on the
    // first frame instead of spending a /api/place-image round trip on a
    // fuzzy search that may return an unrelated photo. Non-Commons OSM image
    // URLs are used directly.
    thumbnail: file ? commonsFilePathUrl(file, 640) : directImage,
    distanceKm: Math.round(haversineKm(center, p) * 100) / 100,
  };
}

/** Dedupe, drop the place the details window is already showing, then sort
 *  nearest-first. */
export function rankNearbyPlaces(
  rows: OsmPoint[],
  center: { lat: number; lng: number },
  limit: number,
  excludeName = ""
): NearbyPlace[] {
  const exclude = normalizeName(excludeName);
  // Nominatim's `importance` is the only prominence signal we get for free.
  // A pure distance sort put "M" (an unnamed rock 3 km away) above Jantar
  // Mantar (4 km), so famous places get a bounded boost while ordinary shops
  // and cafes still sort by how close they are.
  const scored = rows
    .map((p) => {
      const distanceKm = haversineKm(center, p);
      const importance = Math.min(Math.max(p.importance ?? 0, 0), 0.5);
      return { p, distanceKm, score: distanceKm / (1 + importance * 6) };
    })
    .sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm);

  const out: NearbyPlace[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  for (const { p } of scored) {
    const nameKey = normalizeName(p.name);
    if (nameKey.length < 2 || (exclude && nameKey === exclude)) continue;
    const hasId =
      (p.osmType === "node" || p.osmType === "way" || p.osmType === "relation") &&
      typeof p.osmId === "number";
    const idKey = hasId ? `osm:${p.osmType}/${p.osmId}` : "";
    // OSM sometimes carries the same cafe as a node AND a way, and chain
    // branches (two "Cafe Coffee Day" 200 m apart) are noise in a small
    // suggestion strip. One card per name is what the old list did too.
    if ((idKey && seen.has(idKey)) || seenNames.has(nameKey)) continue;
    if (idKey) seen.add(idKey);
    seenNames.add(nameKey);
    out.push(nearbyPlaceFrom(p, center));
  }
  return out.slice(0, limit);
}
