import { NextRequest } from "next/server";
import { collectPhotoCandidates } from "@/lib/placePhotos";
import { resolvePlaceContext, titleMentions } from "@/lib/placeQuery";
import { photoSourceName } from "@/lib/photoCredit";

export const runtime = "nodejs";

/**
 * The photos of one hotel.
 *
 * Sources: Wikimedia Commons + Openverse (the hotel's own article photos,
 * keyless) and Pixabay (the free quota we hold) — see src/lib/placePhotos.ts.
 * They race, each with its own budget, and the hits whose title names the
 * hotel lead, so a photo of a different hotel never opens the gallery.
 */
export async function POST(req: NextRequest) {
  try {
    const { name, city, lat, lng } = await req.json().catch(() => ({}));
    const hotel = String(name ?? "").trim();
    if (!hotel) return Response.json({ photos: [] });

    const la = typeof lat === "number" ? lat : parseFloat(String(lat ?? ""));
    const lo = typeof lng === "number" ? lng : parseFloat(String(lng ?? ""));
    const hasCoords = Number.isFinite(la) && Number.isFinite(lo);

    // "{hotel} {city} {country}" so "Le Marais" cannot match a wetland.
    const ctx = await resolvePlaceContext({
      name: hotel,
      lat: hasCoords ? la : undefined,
      lng: hasCoords ? lo : undefined,
      city: typeof city === "string" ? city : undefined,
    });

    const candidates = await collectPhotoCandidates(ctx.query, {
      limit: 24,
      surface: "detail",
      // Same rule as /api/place-photos: a hotel gallery only accepts photos
      // that actually know this hotel. Stock answered the category and could
      // show a different building entirely.
      sources: ["commons", "openverse"],
    });
    const validated = candidates.filter((c) => titleMentions(c.title, ctx));
    const photos: Array<{ url: string; thumb: string; section: string; source?: string }> = [];
    const seen = new Set<string>();
    for (const c of [...validated, ...candidates.filter((c) => !titleMentions(c.title, ctx))]) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      photos.push({
        url: c.url,
        thumb: c.url,
        section: "Photo",
        source: photoSourceName(c.source, c.url),
      });
      if (photos.length >= 24) break;
    }

    return Response.json({ photos });
  } catch (err) {
    console.error("Hotel photos error:", err);
    return Response.json({ photos: [] });
  }
}
