import { NextRequest } from "next/server";
import { collectPhotoCandidates } from "@/lib/placePhotos";
export const runtime = "nodejs";

/** Short-lived response cache: the same place is re-queried while browsing. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const responseCache = new Map<string, { at: number; images: MappedImage[] }>();

function readCache(key: string): MappedImage[] | null {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return hit.images;
}

function writeCache(key: string, images: MappedImage[]) {
  if (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { at: Date.now(), images });
}

const RAPID_HOST = process.env.RAPIDAPI_IMAGES_HOST?.trim();
const RAPID_KEY = process.env.RAPIDAPI_IMAGES_KEY?.trim();

interface MappedImage {
  url: string;
  thumbnail: string;
  title: string;
  source: string;
  link: string;
}

function isValidUrl(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** The host a photo came from — shown as the image's source. */
function sourceOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Primary image source: RapidAPI Google Images (`getGoogleImages`).
 * Returns [] on any failure/timeout so callers can fall back.
 */
async function rapidImages(query: string, count: number): Promise<MappedImage[]> {
  if (!RAPID_HOST || !RAPID_KEY) return [];
  try {
    const url =
      `https://${RAPID_HOST}/getGoogleImages` +
      `?query=${encodeURIComponent(query)}&count=${count}&imageInfo=true`;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": RAPID_HOST,
        "x-rapidapi-key": RAPID_KEY,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      images?: Array<{ url?: string; width?: number; height?: number; mime?: string }>;
    };
    const raw = Array.isArray(data?.images) ? data.images : [];
    return raw
      .map((img) => {
        if (!isValidUrl(img?.url)) return null;
        const w = typeof img.width === "number" ? img.width : 0;
        const h = typeof img.height === "number" ? img.height : 0;
        if ((w && w < 250) || (h && h < 180)) return null;
        let source = "";
        try {
          source = new URL(img.url!).hostname.replace(/^www\./, "");
        } catch {
          source = "";
        }
        return { url: img.url!, thumbnail: img.url!, title: query, source, link: "" };
      })
      .filter((x): x is MappedImage => x !== null);
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const { q, num } = await req.json().catch(() => ({}));
    const query = String(q ?? "").trim();
    if (!query) {
      return Response.json({ error: "q required" }, { status: 400 });
    }

    const count = typeof num === "number" ? Math.min(Math.max(num, 1), 20) : 8;

    const cacheKey = `${query.toLowerCase()}|${count}`;
    const cached = readCache(cacheKey);
    if (cached && cached.length > 0) return Response.json({ images: cached });

    // The shared pipeline: Wikimedia Commons + Openverse (keyless) and
    // Pixabay race, each with its own budget (see src/lib/placePhotos.ts).
    // A source that is slow or has nothing must not hold the whole search.
    const candidates = await collectPhotoCandidates(query, {
      limit: count + 6,
      surface: "detail",
    });
    const seen = new Set<string>();
    const images: MappedImage[] = [];
    for (const c of candidates) {
      if (!isValidUrl(c.url) || seen.has(c.url)) continue;
      seen.add(c.url);
      images.push({
        url: c.url,
        thumbnail: c.url,
        title: c.title.slice(0, 160) || query,
        source: sourceOf(c.url),
        link: "",
      });
      if (images.length >= count) break;
    }

    // Top up with the user's RapidAPI Google Images key when free sources fall short.
    if (images.length < count) {
      const rapid = await rapidImages(query, count);
      for (const img of rapid) {
        if (seen.has(img.url)) continue;
        seen.add(img.url);
        images.push(img);
        if (images.length >= count) break;
      }
    }

    const result = images.slice(0, 12);
    if (result.length > 0) writeCache(cacheKey, result);
    return Response.json({ images: result });
  } catch (err) {
    console.error("Images search error:", err);
    return Response.json({ images: [] });
  }
}
