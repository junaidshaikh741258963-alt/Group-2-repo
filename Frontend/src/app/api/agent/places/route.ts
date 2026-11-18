import { NextRequest } from "next/server";
import { geocodeCenter, nominatimInViewbox, overpassNearby } from "@/lib/osm";

export const runtime = "nodejs";

/**
 * Step 2 of the plan builder: places to visit. The list comes from
 * OpenStreetMap (Overpass) - the paid provider that used to answer first
 * is gone, so the free sweep is the source now.
 */

export interface PlaceCard {
  name: string;
  rating?: number;
  reviews?: number;
  type?: string;
  address?: string;
  openState?: string;
  description?: string;
  price?: string;
  thumbnail?: string;
  lat?: number;
  lng?: number;
  link?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { destination, count, interests } = await req.json();
    const q0 = String(destination ?? "").trim();
    if (!q0) return Response.json({ error: "destination required" }, { status: 400 });

    const interestList = Array.isArray(interests)
      ? interests.filter((i: unknown) => typeof i === "string" && i.trim()).slice(0, 3)
      : [];
    const focus = interestList.length > 0 ? ` (${interestList.join(", ")})` : "";

    const limit = typeof count === "number" ? Math.min(Math.max(count, 1), 20) : 10;

    // Free place search (OpenStreetMap over Overpass) — the paid provider
    // that used to answer first is gone, so this is the only source now.
    let places: PlaceCard[] = [];
    const center = await geocodeCenter(q0);
    if (center) {
      const osm = await overpassNearby({
        lat: center.lat,
        lng: center.lng,
        query: "tourist attractions",
        radiusKm: 10,
        limit,
      });
      places = osm.map((p) => ({
        name: p.name,
        type: p.category,
        address: p.address,
        openState: p.openingHours,
        lat: p.lat,
        lng: p.lng,
      }));

      // The sweep is the only source, and a congested mirror can outlast its
      // budget — a plan builder that answers with an EMPTY list is useless,
      // so the keyless POI search backstops it. It is scoped to the city, so
      // it cannot answer with another town's sights.
      if (places.length === 0) {
        const pois = await nominatimInViewbox(
          "tourist attractions",
          center.lat,
          center.lng,
          8,
          limit
        );
        places = pois.map((p) => ({
          name: p.name,
          type: p.category,
          address: p.address,
          openState: p.openingHours,
          lat: p.lat,
          lng: p.lng,
        }));
      }
    }

    places = places.slice(0, limit);

    return Response.json({ places, focus });
  } catch (err) {
    console.error("Places search error:", err);
    return Response.json({ places: [] });
  }
}
