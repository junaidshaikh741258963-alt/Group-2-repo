import { overpassQuery } from "../osm";

export interface HotelResult {
  id: number;
  name: string;
  lat: number;
  lng: number;
  address: string;
  stars: number;
  pricePerNight: number;
  currency: string;
  amenities: string[];
  distanceFromCenter: number;
  type: string;
}

export async function searchHotels(
  lat: number,
  lng: number,
  radiusKm: number = 5,
  limit: number = 15
): Promise<HotelResult[]> {
  const query = `
    [out:json][timeout:12];
    (
      node["tourism"~"hotel|motel|hostel|guest_house"](around:${radiusKm * 1000},${lat},${lng});
      way["tourism"~"hotel|motel|hostel|guest_house"](around:${radiusKm * 1000},${lat},${lng});
    );
    out center body;
  `;

  try {
    const data = await overpassQuery(query);
    if (!data) return [];

    const hotels: HotelResult[] = [];
    const elements = Array.isArray(data.elements)
      ? (data.elements as Array<Record<string, unknown>>)
      : [];

    for (const el of elements.slice(0, limit)) {
      const tags = (el.tags as Record<string, string>) || {};
      const hotelLat = (el.lat as number) || (el.center as { lat?: number } | undefined)?.lat;
      const hotelLng = (el.lon as number) || (el.center as { lon?: number } | undefined)?.lon;
      if (!hotelLat || !hotelLng) continue;

      const name = tags["name"];
      if (!name) continue;

      const stars = getStarRating(tags);
      const dist = haversineDistance(lat, lng, hotelLat, hotelLng);

      hotels.push({
        id: Number.isFinite(Number(el.id)) ? Number(el.id) : hotels.length + 1,
        name,
        lat: hotelLat,
        lng: hotelLng,
        address:
          [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]]
            .filter(Boolean)
            .join(" ") || "Nearby",
        stars,
        pricePerNight: estimatePrice(stars, tags),
        currency: "USD",
        amenities: getAmenities(tags),
        distanceFromCenter: Math.round(dist * 100) / 100,
        type: tags["tourism"] || "hotel",
      });
    }

    hotels.sort((a, b) => a.pricePerNight - b.pricePerNight);
    return hotels;
  } catch {
    return [];
  }
}

function getStarRating(tags: Record<string, string>): number {
  if (tags["stars"]) {
    const s = parseInt(tags["stars"]);
    if (s >= 1 && s <= 5) return s;
  }
  if (tags["tourism"] === "hostel") return 1;
  if (tags["tourism"] === "motel") return 2;
  if (tags["tourism"] === "guest_house") return 3;
  return 3;
}

function estimatePrice(stars: number, tags: Record<string, string>): number {
  const base: Record<number, number> = { 1: 45, 2: 75, 3: 120, 4: 200, 5: 350 };
  let price = base[stars] || 100;
  if (tags["tourism"] === "hostel") price = 35;
  if (tags["tourism"] === "motel") price = 65;
  if (tags["tourism"] === "guest_house") price = 85;
  return price;
}

function getAmenities(tags: Record<string, string>): string[] {
  const amenities: string[] = [];
  if (tags["internet_access"] === "yes" || tags["internet_access"] === "wlan")
    amenities.push("Free WiFi");
  if (tags["parking"] === "yes" || tags["parking"] === "surface") amenities.push("Parking");
  if (tags["swimming_pool"] === "yes") amenities.push("Pool");
  if (tags["gym"] === "yes") amenities.push("Gym");
  if (tags["spa"] === "yes") amenities.push("Spa");
  if (tags["wheelchair"] === "yes") amenities.push("Accessible");
  if (tags["amenity"] === "restaurant" || tags["food"] === "yes") amenities.push("Restaurant");
  if (amenities.length === 0) amenities.push("WiFi");
  return amenities;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatHotelsForAgent(hotels: HotelResult[]): string {
  if (hotels.length === 0) return "No hotel data available.";
  return hotels
    .map(
      (h) =>
        `- ${h.name} (${h.stars}★, ~$${h.pricePerNight}/night): ${h.type}, ${h.address}, ${h.distanceFromCenter}km from center, Amenities: ${h.amenities.join(", ")}`
    )
    .join("\n");
}
