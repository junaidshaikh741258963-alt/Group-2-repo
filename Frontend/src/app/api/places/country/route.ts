import { NextRequest } from "next/server";
import { enforceRateLimit } from "@/server/rateLimit";
import { countryDestinations } from "@/lib/countryPlaces";

export const runtime = "nodejs";

/**
 * Country destinations for the Explore location picker.
 *
 * POST { code: "ru", limit?: number }
 *  → { countryCode, places: [{ id, name, lat, lng, population }], total, source }
 *
 * A country's geocoded centre is not a city — Russia's sits in Siberia — so
 * sweeping a few kilometres around it finds nothing. This answers the useful
 * question instead: which cities in that country are worth a trip? The list
 * is real Wikidata data (population-ranked), cached in-process for a day, and
 * the client can retry an honest 503 if the endpoint is briefly unreachable.
 */
export async function POST(req: NextRequest) {
  const limited = enforceRateLimit(req, { scope: "places-country", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? "").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) {
    return Response.json({ error: "ISO 3166-1 alpha-2 country code required" }, { status: 400 });
  }
  const limitRaw = typeof body.limit === "number" ? Math.floor(body.limit) : 24;
  const limit = Math.min(Math.max(limitRaw, 1), 40);

  try {
    const result = await countryDestinations(code);
    return Response.json(
      {
        countryCode: result.countryCode,
        places: result.places.slice(0, limit),
        total: result.places.length,
        source: result.source,
      },
      // The list is stable for a day server-side; the browser may keep it for
      // ten minutes, so flicking back to a country paints instantly.
      { headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=86400" } }
    );
  } catch (err) {
    console.error("Country places error:", err);
    return Response.json(
      {
        error: "Destination list is unavailable right now — try again in a moment.",
        countryCode: code,
        places: [],
        total: 0,
        source: "wikidata",
      },
      { status: 503 }
    );
  }
}
