import { overpassQuery } from "../osm";

export interface Place {
  name: string;
  category: string;
  lat: number;
  lng: number;
  address: string;
  openingHours?: string;
  website?: string;
  phone?: string;
}

export async function searchAttractions(
  lat: number,
  lng: number,
  radiusKm: number = 10,
  limit: number = 20
): Promise<Place[]> {
  const query = `
    [out:json][timeout:12];
    (
      node["tourism"~"attraction|museum|gallery|monument|artwork|viewpoint|zoo|aquarium"](around:${radiusKm * 1000},${lat},${lng});
      node["leisure"~"park|garden|stadium|sports_centre"](around:${radiusKm * 1000},${lat},${lng});
      node["amenity"~"place_of_worship|theatre|cinema|nightclub|cafe|restaurant|bar|pub"](around:${radiusKm * 1000},${lat},${lng});
      way["tourism"~"attraction|museum|gallery|monument|artwork|viewpoint"](around:${radiusKm * 1000},${lat},${lng});
      way["leisure"~"park|garden|stadium"](around:${radiusKm * 1000},${lat},${lng});
    );
    out center body;
  `;

  try {
    const data = await overpassQuery(query);
    if (!data) return [];

    const places: Place[] = [];
    const elements = Array.isArray(data.elements)
      ? (data.elements as Array<Record<string, unknown>>)
      : [];

    for (const el of elements.slice(0, limit)) {
      const tags = (el.tags as Record<string, string>) || {};
      const placeLat = (el.lat as number) || (el.center as { lat?: number } | undefined)?.lat;
      const placeLng = (el.lon as number) || (el.center as { lon?: number } | undefined)?.lon;
      if (!placeLat || !placeLng) continue;

      const name = tags["name"];
      if (!name) continue;

      const category = getCategory(tags);
      const address =
        [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]]
          .filter(Boolean)
          .join(" ") || "";

      places.push({
        name,
        category,
        lat: placeLat,
        lng: placeLng,
        address,
        openingHours: tags["opening_hours"],
        website: tags["website"],
        phone: tags["phone"] || tags["contact:phone"],
      });
    }

    return places;
  } catch {
    return [];
  }
}

function getCategory(tags: Record<string, string>): string {
  if (tags["tourism"] === "museum") return "museum";
  if (tags["tourism"] === "attraction") return "attraction";
  if (tags["tourism"] === "viewpoint") return "viewpoint";
  if (tags["leisure"] === "park" || tags["leisure"] === "garden") return "park";
  if (tags["amenity"] === "restaurant") return "restaurant";
  if (tags["amenity"] === "cafe") return "cafe";
  if (tags["amenity"] === "bar" || tags["amenity"] === "pub") return "nightlife";
  if (tags["amenity"] === "theatre" || tags["amenity"] === "cinema") return "entertainment";
  if (tags["amenity"] === "place_of_worship") return "religious";
  if (tags["tourism"] === "artwork") return "monument";
  return "attraction";
}

export function formatPlacesForAgent(places: Place[]): string {
  if (places.length === 0) return "No places data available.";
  return places
    .map(
      (p) =>
        `- ${p.name} (${p.category}): ${p.address || "Near destination"}${p.openingHours ? `, Hours: ${p.openingHours}` : ""}`
    )
    .join("\n");
}
