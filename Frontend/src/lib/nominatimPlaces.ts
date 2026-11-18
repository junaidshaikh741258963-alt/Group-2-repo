/**
 * Nominatim → CityPlace rows — the Overpass-down fallback for /api/places/city.
 *
 * When every Overpass mirror fails, the route still owes the user a real
 * list: one bounded Nominatim viewbox search per category keyword
 * (`NOMINATIM_KEYWORDS`, normalised by `nominatimInViewbox`'s phrase mapping)
 * produces a small but genuine pool. Identity reuses the OSM `osm:type/id`
 * so photo/detail lookups behave exactly like Overpass rows, and Nominatim's
 * `importance` feeds `scorePlace` so famous places still lead.
 *
 * Pure functions — unit-tested without network; the fetching (and the 1 req/s
 * pacing Nominatim's usage policy asks for) lives in the route.
 */

import { haversineKm, type OsmPoint } from "./osm";
import { nameKey, sanitizeName, type CityCategory, type CityPlace } from "./cityPlaces";

/** Free-text keywords per category — one bounded viewbox search each. */
export const NOMINATIM_KEYWORDS: Record<CityCategory, readonly string[]> = {
  hotels: ["hotel"],
  restaurants: ["restaurant"],
  attractions: ["tourist attraction", "museum"],
  experiences: ["tourist attraction", "park"],
  landmarks: ["monument", "castle"],
  highlights: ["tourist attraction", "museum"],
};

/** "Cafe X, 12 St, 75008 Paris, France" → "12 St, 75008 Paris, France". */
function shortAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(-3).join(", ").slice(0, 140) || undefined;
}

export function collectNominatimPlaces(
  points: OsmPoint[],
  center: { lat: number; lng: number }
): CityPlace[] {
  const out: CityPlace[] = [];
  for (const p of points) {
    const name = sanitizeName(p.name);
    if (!name || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    out.push({
      id:
        p.osmType && typeof p.osmId === "number"
          ? `osm:${p.osmType}/${p.osmId}`
          : `nom:${nameKey(name).replace(/ /g, "-")}`,
      name,
      lat: p.lat,
      lng: p.lng,
      address: shortAddress(p.address),
      importance: typeof p.importance === "number" && p.importance > 0 ? p.importance : undefined,
      distanceKm: haversineKm(center, p),
      score: 0,
    });
  }
  return out;
}
