import type { Hotel } from "./hotels";

import { SHOWCASE_PHOTOS } from "./showcasePhotos";
import { commonsFileFromTag, commonsFilePathUrl } from "./commonsFile";
import type { AiReply, StructuredPlace } from "@/lib/ai/aiSchema";
import { resolveVisitDuration, type ResolvedDuration } from "./itinerary/durations";

export type RecType = "destination" | "hotel" | "restaurant" | "attraction" | "airport";

export interface Recommendation {
  id: string;
  name: string;
  type: RecType;
  lat?: number;
  lng?: number;
  /** City/area the place sits in — used to sharpen image lookups. */
  city?: string;
  description?: string;
  rating?: number;
  /** How many people rated it, when the source knows — rendered as 13k / 14.3k. */
  reviews?: number;
  price?: string;
  /** Provenance of the recommendation ("Live search", "Knowledge base", …),
   *  printed on the card so the user can see where the pick came from. */
  source?: string;
  image?: string;
  propertyToken?: string;
  link?: string;
  /** Resolved time-on-site estimate (Phase 4) — override > model > text > category. */
  visitDuration?: ResolvedDuration;
  /** "09:00-17:00" when known — drives the open/closed chip. */
  openingHours?: string;
  /** Live data timestamp (epoch ms) when a provider supplied freshness. */
  updatedAt?: number;
}

const OPEN_TAG = "<recommendations>";
const CLOSE_TAG = "</recommendations>";

const VALID_TYPES: RecType[] = ["destination", "hotel", "restaurant", "attraction", "airport"];

const PLACE_IMAGES: Array<{ match: RegExp; img: string }> = [
  { match: /paris|eiffel/i, img: SHOWCASE_PHOTOS.paris },
  { match: /santorini|greece/i, img: SHOWCASE_PHOTOS.santorini },
  {
    match: /machu picchu|peru|cusco/i,
    img: "https://images.unsplash.com/photo-1526392060635-9d6019884377?w=600&q=80&auto=format&fit=crop",
  },
  { match: /kyoto|japan|tokyo/i, img: SHOWCASE_PHOTOS.tokyo },
  {
    match: /amalfi|italy|rome|venice|florence/i,
    img: "https://images.unsplash.com/photo-1534308983496-4fabb1a015ee?w=600&q=80&auto=format&fit=crop",
  },
  { match: /maldives/i, img: SHOWCASE_PHOTOS.maldives },
  {
    match: /swiss|alps|zurich|switzerland/i,
    img: "https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=600&q=80&auto=format&fit=crop",
  },
  { match: /bali|indonesia/i, img: SHOWCASE_PHOTOS.bali },
  {
    match: /london|uk|england/i,
    img: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=600&q=80&auto=format&fit=crop",
  },
  {
    match: /dubai/i,
    img: "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?w=600&q=80&auto=format&fit=crop",
  },
  { match: /new york|nyc|manhattan/i, img: SHOWCASE_PHOTOS.newYork },
  {
    match: /barcelona|spain/i,
    img: "https://images.unsplash.com/photo-1583422409516-2895a77efded?w=600&q=80&auto=format&fit=crop",
  },
];

const CATEGORY_META: Record<RecType, { emoji: string; color: string; label: string }> = {
  destination: { emoji: "📍", color: "#3b82f6", label: "Destination" },
  hotel: { emoji: "🏨", color: "#a855f7", label: "Hotel" },
  restaurant: { emoji: "🍽️", color: "#f97316", label: "Restaurant" },
  attraction: { emoji: "🎯", color: "#10b981", label: "Attraction" },
  airport: { emoji: "✈️", color: "#38bdf8", label: "Airport" },
};

export function recMeta(type: RecType) {
  return CATEGORY_META[type];
}

/**
 * Image for a single place. Prefers the image returned with that recommendation.
 * An OSM `image` tag is turned into its Commons URL locally — that place has
 * a known photo, so the card can paint it on the first frame instead of
 * waiting for a lookup round trip.
 * Returns null when there is no per-place image — callers resolve further or show a placeholder.
 * City stock photos apply ONLY to destination cards; never to hotels/restaurants/attractions
 * (they used to share one photo per city name pattern).
 */
export function recImage(item: {
  type: RecType;
  name: string;
  image?: string;
  /** OSM `image` / `wikimedia_commons` tag, when the place carries one. */
  imageTag?: string;
}): string | null {
  if (item.image && /^https?:\/\//i.test(item.image.trim())) return item.image.trim();
  const file = commonsFileFromTag(item.imageTag);
  if (file) return commonsFilePathUrl(file);
  if (item.type !== "destination") return null;
  const hit = PLACE_IMAGES.find((d) => d.match.test(item.name));
  return hit ? hit.img : null;
}

/** Maps a raw category string ("hotel", "museum", "resort"…) to a RecType. */
export function coerceType(value: unknown): RecType {
  const t = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if ((VALID_TYPES as string[]).includes(t)) return t as RecType;
  if (t === "airport" || t === "aerodrome" || t === "airfield") return "airport";
  if (t === "attraction" || t === "sight" || t === "landmark" || t === "museum")
    return "attraction";
  if (
    t === "hostel" ||
    t === "guesthouse" ||
    t === "guest house" ||
    t === "motel" ||
    t === "b&b" ||
    t === "bnb" ||
    t === "inn" ||
    t === "lodge" ||
    t === "lodging" ||
    t === "resort" ||
    t === "apartment"
  ) {
    return "hotel";
  }
  // OSM's amenity values are the common case for nearby cards. "cafe",
  // "fast food" and "bar" used to fall through to attraction, so tapping a
  // cafe opened a landmark window (no nearby strip, wrong category badge).
  if (
    /\b(restaurant|cafe|café|coffee|bakery|bistro|diner|eatery|pizzeria|steakhouse|food|brunch|bar|pub|biergarten)(?![a-z])/.test(
      t
    )
  ) {
    return "restaurant";
  }
  return "attraction";
}

function parseItems(raw: string): Array<Omit<Recommendation, "id">> {
  let data: unknown = null;
  const trimmed = raw.trim();
  try {
    data = JSON.parse(trimmed);
  } catch {
    const s = trimmed.indexOf("[");
    const e = trimmed.lastIndexOf("]");
    if (s !== -1 && e > s) {
      try {
        data = JSON.parse(trimmed.slice(s, e + 1));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  let arr: unknown[] = [];
  if (Array.isArray(data)) arr = data;
  else if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { recommendations?: unknown[] }).recommendations)
  ) {
    arr = (data as { recommendations: unknown[] }).recommendations;
  }

  const out: Array<Omit<Recommendation, "id">> = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const lat = typeof r.lat === "number" ? r.lat : parseFloat(String(r.lat));
    const lng = typeof r.lng === "number" ? r.lng : parseFloat(String(r.lng));
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const rating = typeof r.rating === "number" ? r.rating : parseFloat(String(r.rating));
    out.push({
      name,
      type: coerceType(r.type),
      lat,
      lng,
      description: typeof r.description === "string" ? r.description.slice(0, 160) : undefined,
      rating:
        Number.isFinite(rating) && rating >= 0 && rating <= 5
          ? Math.round(rating * 10) / 10
          : undefined,
      price: typeof r.price === "string" ? r.price.slice(0, 40) : undefined,
      image:
        typeof r.image === "string" && /^https?:\/\//.test(r.image)
          ? r.image.slice(0, 500)
          : undefined,
    });
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Parse ALL <recommendations> blocks in a message (the model may emit one per
 * category — hotels, restaurants, attractions). Returns the visible text with
 * every block removed, plus items numbered stably across blocks.
 * An unclosed block (mid-stream) is hidden from the text and yields no items.
 *
 * Pure, so results are memoized by content: streaming re-parses the whole
 * history on every token otherwise. Callers must treat the result as
 * read-only (copy items before mutating).
 */
const SPLIT_CACHE_LIMIT = 256;
const splitCache = new Map<string, { text: string; items: Recommendation[] }>();

function computeSplitRecommendations(content: string): { text: string; items: Recommendation[] } {
  const firstOpen = content.indexOf(OPEN_TAG);
  if (firstOpen === -1) return { text: content, items: [] };

  // Hide a block that is still streaming in (open tag with no close yet).
  let cutAt = content.length;
  for (let i = firstOpen; i !== -1; i = content.indexOf(OPEN_TAG, i + 1)) {
    if (content.indexOf(CLOSE_TAG, i) === -1) {
      cutAt = i;
      break;
    }
  }

  const items: Recommendation[] = [];
  let text = "";
  let cursor = 0;
  const re = new RegExp(`${OPEN_TAG}([\\s\\S]*?)${CLOSE_TAG}`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index >= cutAt) break;
    text += content.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    for (const r of parseItems(m[1])) {
      if (items.length >= 36) break;
      items.push({ ...r, id: String(items.length) });
    }
    if (items.length >= 36) break;
  }
  text += content.slice(cursor, cutAt);

  return {
    text: text.replace(/```(?:json)?\s*$/i, "").trimEnd(),
    items,
  };
}

export function splitRecommendations(content: string): { text: string; items: Recommendation[] } {
  const cached = splitCache.get(content);
  if (cached) {
    // Refresh recency so live content wins over stale streaming chunks.
    splitCache.delete(content);
    splitCache.set(content, cached);
    return cached;
  }
  const result = computeSplitRecommendations(content);
  if (splitCache.size >= SPLIT_CACHE_LIMIT) {
    const oldest = splitCache.keys().next().value;
    if (oldest !== undefined) splitCache.delete(oldest);
  }
  splitCache.set(content, result);
  return result;
}

export function collectRecommendations(
  messages: Array<{ id: string; role: string; content: string; structured?: AiReply }>
): Recommendation[] {
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const items = itemsForAssistant(msg.id, msg.content, msg.structured);
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  // Identity-stable: streaming re-creates the messages array every token, but
  // the derived items are cached — when nothing actually changed, hand back
  // the previous array so downstream memos (results → markers → map) skip.
  if (lastCollect.length === out.length && out.every((r, i) => r === lastCollect[i])) {
    return lastCollect;
  }
  lastCollect = out;
  return out;
}
let lastCollect: Recommendation[] = [];

export function itemsForMessage(messageId: string, content: string): Recommendation[] {
  const { items } = splitRecommendations(content);
  return items.map((item) => ({ ...item, id: `${messageId}:${item.id}` }));
}

/**
 * Cards for a structured reply. Ids are `${messageId}:s${index}` so the chat
 * card, the map pin and the itinerary timeline all reference the same place.
 * `pace` applies the traveller's personalization to visit durations.
 */
export function itemsFromStructured(
  messageId: string,
  reply: AiReply,
  pace?: string | null
): Recommendation[] {
  return reply.places.map((p: StructuredPlace, i: number) => ({
    id: `${messageId}:s${i}`,
    name: p.name,
    type: coerceType(p.category),
    lat: p.lat,
    lng: p.lng,
    city: p.city || undefined,
    description: p.description || undefined,
    rating: p.rating,
    // No priceLevel? The estimated cost ("€15 pp") is the same information in
    // the same slot — the card's price line just shows whichever we have.
    price: p.priceLevel || p.cost || undefined,
    /** Provenance printed on the card: "Live search", "Knowledge base", … */
    source: p.source || undefined,
    openingHours: p.openingHours || undefined,
    visitDuration: resolveVisitDuration({
      name: p.name,
      category: p.category,
      durationText: p.duration,
      model: p.visitDuration ?? null,
      pace,
    }),
  }));
}

/**
 * Keep exactly one card category from a mixed list (legacy `<recommendations>`
 * payloads). The largest group wins; ties keep the first type seen, which is
 * the order the model tends to write (destination → attraction → food → stay).
 * A single-category list is returned untouched, preserving reference identity.
 */
export function singleShelf(items: Recommendation[]): Recommendation[] {
  if (items.length <= 1) return items;
  const counts = new Map<RecType, number>();
  let best: RecType = items[0].type;
  let bestCount = 0;
  for (const item of items) {
    const n = (counts.get(item.type) ?? 0) + 1;
    counts.set(item.type, n);
    if (n > bestCount) {
      best = item.type;
      bestCount = n;
    }
  }
  const filtered = items.filter((item) => item.type === best);
  return filtered.length > 0 ? filtered : items;
}

/**
 * Card items for one assistant message, whichever format it was written in.
 *
 * Identity-cached: the chat page re-derives every message's cards on each
 * streaming frame, so an unchanged message must hand back the exact same
 * array (and the same item objects). Only the actively-streaming message
 * misses the cache. Callers must treat the result as read-only.
 */
const ASSISTANT_CACHE_LIMIT = 512;
const assistantCache = new Map<
  string,
  {
    content: string;
    structured: AiReply | undefined;
    pace: string | null | undefined;
    items: Recommendation[];
  }
>();

export function itemsForAssistant(
  messageId: string,
  content: string,
  structured?: AiReply,
  pace?: string | null
): Recommendation[] {
  const hit = assistantCache.get(messageId);
  if (hit && hit.content === content && hit.structured === structured && hit.pace === pace)
    return hit.items;

  const raw = structured
    ? itemsFromStructured(messageId, structured, pace)
    : itemsForMessage(messageId, content);
  // The reply's destination is a safe city hint for cards whose model payload
  // omitted it. Applying it here (not only in the chat card renderer) means the
  // map, geocoder and image lookups all see the same city the card shows.
  const city = structured?.destination?.trim();
  const items =
    city && raw.some((item) => !item.city && item.type !== "destination")
      ? raw.map((item) =>
          item.city || item.type === "destination" ? item : { ...item, city }
        )
      : raw;

  if (!hit && assistantCache.size >= ASSISTANT_CACHE_LIMIT) {
    const oldest = assistantCache.keys().next().value;
    if (oldest !== undefined) assistantCache.delete(oldest);
  }
  assistantCache.set(messageId, { content, structured, pace, items });
  return items;
}

let lastMerged: Recommendation[] = [];

/**
 * Chat cards + stage-enriched extras, deduped by name. Returns a
 * reference-stable array when the merged list is element-wise identical to
 * the previous call, so `results` → `markers` → the map all keep their
 * identity across streaming re-renders (memoized children then bail out).
 */
export function mergeRecommendations(
  base: Recommendation[],
  extras: Recommendation[]
): Recommendation[] {
  if (extras.length === 0) return base;
  const seen = new Set<string>();
  const merged = [...base];
  for (const r of base) seen.add(r.name.toLowerCase());
  for (const h of extras) {
    const key = h.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(h);
    }
  }
  if (lastMerged.length === merged.length && merged.every((r, i) => r === lastMerged[i])) {
    return lastMerged;
  }
  lastMerged = merged;
  return merged;
}

export function extractDestination(...texts: string[]): string | null {
  const joined = texts.filter(Boolean).join("\n");
  const patterns = [
    /\bhotels?\s+(?:in|near|at|around|downtown|city\s+center\s+in)\s+([A-Za-z][A-Za-z\s'-]{2,40})/i,
    /\b(?:trip|travel|visit|vacation|holiday|itinerary|stay)\s+(?:to|in)\s+([A-Za-z][A-Za-z\s'-]{2,40})/i,
    /\bin\s+([A-Z][a-zA-Z\s'-]{2,40})/,
  ];
  for (const p of patterns) {
    const m = joined.match(p);
    if (m?.[1]) {
      const cleaned = m[1]
        .split(/[.?,!;\n]/)[0]
        .replace(/\s+(?:for|and|with|during|that|this)\s+.*$/i, "")
        .trim();
      if (cleaned.length >= 3) return cleaned;
    }
  }
  return null;
}

/**
 * Split markdown into a stable prefix (complete blocks, safe to render as
 * markdown) and a tail (incomplete block shown as plain text while typing).
 * Fence-aware: never splits inside an open ``` block.
 * Also commits at common block boundaries so streaming causes less reflow.
 */
export function partitionMarkdown(md: string): { stable: string; tail: string } {
  let inFence = false;
  let openFenceAt = -1;
  let lastBoundary = 0;
  let lineStart = 0;

  const isBlockStart = (idx: number, line: string) => {
    if (!line) return false;
    if (line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) return true;
    if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) return true;
    if (/^\d+\.\s/.test(line)) return true;
    if (line.startsWith("---") || line.startsWith("===")) return true;
    void idx;
    return false;
  };

  for (let i = 0; i < md.length; i++) {
    const ch = md[i];

    if (ch === "`" && md[i + 1] === "`" && md[i + 2] === "`" && (i === 0 || md[i - 1] === "\n")) {
      if (!inFence) {
        inFence = true;
        openFenceAt = i;
      } else {
        inFence = false;
        openFenceAt = -1;
      }
      i += 2;
      lineStart = i + 1;
      continue;
    }

    if (ch === "\n") {
      const nextLineStart = i + 1;
      if (!inFence) {
        if (md[i + 1] === "\n") {
          lastBoundary = nextLineStart + 1;
        } else if (
          nextLineStart < md.length &&
          isBlockStart(nextLineStart, md.slice(nextLineStart))
        ) {
          lastBoundary = nextLineStart;
        }
      }
      lineStart = nextLineStart;
    }
  }

  if (inFence && openFenceAt >= 0) {
    const before = md.lastIndexOf("\n\n", openFenceAt);
    const beforeLine = md.lastIndexOf("\n", openFenceAt);
    lastBoundary = Math.max(before === -1 ? 0 : before + 2, beforeLine === -1 ? 0 : beforeLine + 1);
  }

  void lineStart;
  return {
    stable: md.slice(0, lastBoundary),
    tail: md.slice(lastBoundary),
  };
}

/** Map-search hotel result → in-app detail sheet recommendation. */
export function hotelToRec(h: Hotel): Recommendation {
  return {
    id: `hotel-${h.id}`,
    name: h.name,
    type: "hotel",
    lat: h.lat,
    lng: h.lng,
    city: h.city,
    description: h.address,
    rating: h.stars,
    price: `$${h.pricePerNight}`,
    link: h.website,
  };
}
