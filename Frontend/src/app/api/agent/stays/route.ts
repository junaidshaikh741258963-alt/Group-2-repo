import { NextRequest } from "next/server";
import { detectLocalCurrency } from "@/lib/agent/currency";
import { geocodeCenter, nominatimInViewbox, overpassNearby } from "@/lib/osm";

export const runtime = "nodejs";

/**
 * Step 1 of the plan builder: stays within the trip budget.
 *
 * The stay list comes from OpenStreetMap (Overpass) — the paid provider
 * that used to answer first is gone, so the free sweep is the source.
 */

export interface StayCard {
  name: string;
  rating?: number;
  reviews?: number;
  price?: string;
  priceValue?: number;
  currency: string;
  priceUsd?: number;
  image?: string;
  kind: string;
  amenities: string[];
  lat?: number;
  lng?: number;
  link?: string;
  withinBudget?: boolean;
}

function stayKind(accommodationType: string): string {
  const t = (accommodationType || "").toLowerCase();
  if (t.includes("camping")) return "camping sites";
  if (t.includes("rental") || t.includes("airbnb")) return "vacation rentals";
  if (t.includes("guesthouse") || t.includes("b&b")) return "guesthouses";
  if (t.includes("hostel")) return "hostels";
  if (t.includes("resort")) return "resorts";
  if (t.includes("5-star") || t.includes("luxury")) return "luxury hotels";
  if (t.includes("4-star")) return "4 star hotels";
  if (t.includes("3-star")) return "3 star hotels";
  return "hotels";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const destination = String(body.destination ?? "").trim();
    if (!destination) {
      return Response.json({ error: "destination required" }, { status: 400 });
    }

    const kind = stayKind(String(body.accommodationType ?? ""));
    const currency = detectLocalCurrency(destination);

    // Free stay search (OpenStreetMap over Overpass). The paid provider
    // that used to answer first is gone; this is the only source now.
    let stays: StayCard[] = [];
    const center = await geocodeCenter(destination);
    if (center) {
      const osm = await overpassNearby({
        lat: center.lat,
        lng: center.lng,
        query: kind,
        radiusKm: 10,
        limit: 20,
      });
      stays = osm.map((p) => ({
        name: p.name,
        kind,
        amenities: p.openingHours ? [`Hours: ${p.openingHours}`] : [],
        currency,
        lat: p.lat,
        lng: p.lng,
      }));

      // A congested mirror can outlast the sweep's budget, and a plan
      // builder that answers with an EMPTY list is useless — the keyless POI
      // search backstops it, scoped to the city.
      if (stays.length === 0) {
        const pois = await nominatimInViewbox(kind, center.lat, center.lng, 8, 20);
        stays = pois.map((p) => ({
          name: p.name,
          kind,
          amenities: p.openingHours ? [`Hours: ${p.openingHours}`] : [],
          currency,
          lat: p.lat,
          lng: p.lng,
        }));
      }
    }

    // Budget: nightly cap from the form (fallback ≈ 40% of daily trip budget).
    const budgetRaw = Number(body.accommodationBudget);
    const totalBudget = Number(body.totalBudget);
    const numDays = Number(body.numDays) || 3;
    const nightly =
      budgetRaw > 0
        ? budgetRaw
        : totalBudget > 0
          ? Math.max(20, Math.round((totalBudget / numDays) * 0.4))
          : 0;

    // Form budgets are in USD; the free stay list carries no nightly price,
    // so the budget check is skipped (undefined = conversion unavailable →
    // the chip is hidden in the UI).
    for (const s of stays) {
      if (nightly <= 0) {
        s.withinBudget = true;
      } else if (s.priceUsd != null) {
        s.withinBudget = s.priceUsd <= nightly;
      }
    }

    const within = stays
      .filter((s) => s.withinBudget !== false)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const over = stays
      .filter((s) => s.withinBudget === false)
      .sort((a, b) => (a.priceValue ?? Infinity) - (b.priceValue ?? Infinity));
    stays = [...within, ...over].slice(0, 8);

    return Response.json({ stays, currency, nightlyBudget: nightly });
  } catch (err) {
    console.error("Stays search error:", err);
    return Response.json({ stays: [] });
  }
}
