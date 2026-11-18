import { NextRequest } from "next/server";
import type { Recommendation } from "@/lib/recommendations";
import { searchHotels } from "@/lib/hotels";
import { geocodeCenter, nominatimPois } from "@/lib/osm";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { destination, lat, lng } = await req.json().catch(() => ({}));
    const q = String(destination ?? "").trim();
    if (!q) {
      return Response.json({ error: "destination required" }, { status: 400 });
    }

    let hotels: Recommendation[] = [];

    // The caller's coordinates beat the name: "Rome" geocodes to Rome,
    // Georgia, and the user picked a place on the map.
    const la = typeof lat === "number" ? lat : Number.NaN;
    const lo = typeof lng === "number" ? lng : Number.NaN;
    const center =
      Number.isFinite(la) && Number.isFinite(lo) ? { lat: la, lng: lo } : await geocodeCenter(q);

    // Free hotel search (OpenStreetMap over Overpass), then a free-text
    // Nominatim POI search when Overpass is down. The sweep is the only
    // source now, so it is given room to answer on a slow mirror.
    if (center) {
      const delay = (ms: number) => new Promise<null>((r) => setTimeout(r, ms));
      const osm = await Promise.race([searchHotels(center.lat, center.lng, 8, 12), delay(35_000)]);
      hotels = (osm ?? []).map((h) => ({
        id: `osm-${h.id}`,
        name: h.name,
        type: "hotel" as const,
        lat: h.lat,
        lng: h.lng,
        description: h.address && h.address !== "Nearby" ? h.address : `${h.stars}-star hotel`,
        rating: h.stars >= 2 ? h.stars : undefined,
        price: `$${h.pricePerNight}/night`,
        link: h.website,
      }));
    }

    // Last resort: a free-text Nominatim POI search (works when Overpass is
    // down) — scoped to the centre, so it cannot answer with another city's
    // hotels.
    if (hotels.length === 0 && center) {
      const pois = await nominatimPois(`hotels in ${q}`, 12, center);
      hotels = pois
        .filter((p) =>
          /hotel|hostel|motel|lodge|guest|resort|apartment/i.test(`${p.category} ${p.name}`)
        )
        .map((p, i) => ({
          id: `poi-${i}-${p.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40)}`,
          name: p.name,
          type: "hotel" as const,
          lat: p.lat,
          lng: p.lng,
          description: p.address,
        }));
    }
    return Response.json({ hotels });
  } catch (err) {
    console.error("Hotel search error:", err);
    return Response.json({ hotels: [] });
  }
}
