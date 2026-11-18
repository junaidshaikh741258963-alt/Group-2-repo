/**
 * Structured AI reply contract.
 *
 * The model must answer with ONE JSON object (never plain text, never tags):
 *
 *   { intro, destination, dates, places[], itinerary[], followUpQuestion,
 *     suggestions[] }
 *
 * `aiSchema.ts` owns the zod schema + parsing and is imported by the server
 * route. Client files take the TYPES from here with `import type`, so zod
 * never lands in the browser bundle.
 */

import { z } from "zod";

import { isTravelWindow } from "./travelWindow";

/** The four card categories the renderer knows how to dress. */
export const PLACE_CATEGORIES = ["destination", "attraction", "restaurant", "hotel"] as const;

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * A string field that survives the shapes a model actually emits.
 *
 * `"duration": 2`, `"rating": "4.7"`, `"dates": {"from": …, "to": …}` and a
 * 260-character description used to invalidate the WHOLE reply — the intro
 * would stream, then validation failed, the prompt got a second (usually
 * still-failing) attempt, and the cards never reached the UI. Here everything
 * collapses to a bounded string, which is all the renderer ever wanted.
 *
 * `min` is kept strict so a genuinely missing required key (`name`, `title`,
 * `intro`) still fails and triggers the correction retry.
 */
function str(max: number, min = 0) {
  return z.preprocess((v) => {
    let s: string;
    if (typeof v === "string") s = v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else if (Array.isArray(v)) s = v.filter(isScalar).map(String).join(" · ");
    else if (v && typeof v === "object") {
      const parts = Object.values(v).filter(isScalar).map(String);
      s = parts.join(" – ");
    } else s = "";
    return s.length > max ? s.slice(0, max) : s;
  }, z.string().min(min).max(max));
}

/** Numbers the model sometimes quotes as text: "35.6", "4,7". */
function num(min: number, max: number, opts: { int?: boolean } = {}) {
  return z.preprocess(
    (v) => {
      let n = v;
      if (typeof v === "string") n = Number.parseFloat(v.replace(",", "."));
      // "", null and a missing key all mean "unknown" — an optional field
      // survives them, a required one still fails with a clear "Required".
      if (v === null || v === undefined || v === "") return undefined;
      if (typeof n === "number" && Number.isFinite(n)) return opts.int ? Math.round(n) : n;
      return v;
    },
    opts.int ? z.number().int().min(min).max(max) : z.number().min(min).max(max)
  );
}

/**
 * An optional number. `.optional()` alone only short-circuits `undefined`, so
 * a model emitting `"lat": null` would still have failed the whole CARD — and
 * when every card failed, the whole reply. Here null/""/missing all collapse
 * to `undefined`, which the renderer treats as "no map pin".
 */
function optNum(min: number, max: number, opts: { int?: boolean } = {}) {
  // Normalise FIRST: `.optional()` on the inside short-circuits only once the
  // outer preprocess has turned null/"" into undefined.
  return z.preprocess(
    (v) => (v === null || v === undefined || v === "" ? undefined : v),
    num(min, max, opts).optional()
  );
}

/**
 * Model's structured time-on-site estimate. Tolerant by construction: the
 * transform swallows bad shapes so a garbled estimate never costs the card
 * (tolerantArray would otherwise drop the whole entry).
 */
const VisitDurationInner = z.object({
  /** Minutes; 5..1440 covers "quick photo stop" through "full day". */
  minMinutes: num(5, 1440, { int: true }),
  typicalMinutes: num(5, 1440, { int: true }),
  maxMinutes: num(5, 1440, { int: true }),
  /** 0..1 — the model's own confidence. */
  confidence: optNum(0, 1),
  /** One short line on why ("large museum", "guided tour", "quick photo stop"). */
  basis: str(140),
});

export type VisitDuration = z.infer<typeof VisitDurationInner>;

/**
 * Element-wise array parsing: one malformed card must not cost the user the
 * other seven. Bad entries are dropped; the reply only fails (and triggers
 * the correction retry) when *every* entry was unusable.
 */
function tolerantArray<S extends z.ZodType>(schema: S, max: number) {
  return z
    .preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : []), z.array(z.unknown()))
    .transform((items, ctx): z.infer<S>[] => {
      const out: z.infer<S>[] = [];
      for (const item of items) {
        const parsed = schema.safeParse(item);
        if (parsed.success) out.push(parsed.data);
      }
      if (out.length === 0 && items.length > 0) {
        // Carry the first entry's actual issue into the message — without it
        // "every entry was unusable" is undiagnosable from a log line.
        const first = schema.safeParse(items[0]);
        const detail = first.success
          ? ""
          : ` — first entry: ${first.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
              .join(", ")}`;
        ctx.addIssue({
          code: "custom",
          message: `every entry was unusable (${items.length} given, 0 valid)${detail}`,
        });
        return z.NEVER;
      }
      return out;
    });
}

export const StructuredPlaceSchema = z.object({
  name: str(120, 1),
  /** Free text so a bad label never fails the whole reply — coerced later. */
  category: str(32, 1),
  city: str(80),
  /**
   * Optional on purpose: models frequently know a place but not its exact
   * coordinates. Requiring the pair made EVERY card fail validation (the reply
   * was rejected wholesale and the cards never reached the UI). A card without
   * coordinates still renders — it simply gets no map pin.
   */
  lat: optNum(-90, 90),
  lng: optNum(-180, 180),
  description: str(220),
  /** 0–5, one decimal. Optional: the model must omit rather than invent. */
  rating: optNum(0, 5),
  priceLevel: str(48),
  /** Estimated time on site ("2h", "90 min"). Omit when unknown. */
  duration: str(48),
  /** Structured time-on-site estimate (Phase 4). Any garbage / missing /
   *  null value collapses to undefined — never a failed card. The card then
   *  falls back to the duration string or the category table in
   *  lib/itinerary/durations.ts. */
  visitDuration: VisitDurationInner.optional().catch(undefined),
  /** Estimated cost ("Free", "$15 pp", "₹800/night"). Omit when unknown. */
  cost: str(48),
  /** Opening hours as "09:00-17:00" when confidently known. Omit otherwise —
   *  the card then simply doesn't claim open/closed status. */
  openingHours: str(24),
  /** Where this recommendation came from: "Live search" | "Knowledge base" |
   *  "Web search" | "This conversation". Rendered as the card's provenance. */
  source: str(80),
});

export const ItineraryItemSchema = z.object({
  time: str(24),
  title: str(140, 1),
  description: str(240),
  /** Exact name of an entry in `places` when the stop is one of the cards. */
  place: str(140),
  /** Estimated dwell time at this stop. */
  duration: str(48),
  /** Estimated cost for this stop (per person unless stated). */
  cost: str(48),
  /** Opening hours "09:00-17:00" when confidently known. */
  openingHours: str(24),
});

export const ItineraryDaySchema = z.object({
  day: num(1, 60, { int: true }),
  title: str(90),
  items: tolerantArray(ItineraryItemSchema, 12),
});

export const AiReplySchema = z.object({
  /** 1–2 sentences. This is what streams first. */
  intro: str(800, 1),
  /** The trip's destination as the model now understands it ("" = unknown).
   *  Echoed back into the trip context so the next turn never re-asks. */
  destination: str(90),
  /** The trip's dates/travel window as the model now understands it. */
  dates: str(90),
  /** 4–8 real places when recommending; empty for a clarifying question. */
  places: tolerantArray(StructuredPlaceSchema, 8),
  itinerary: tolerantArray(ItineraryDaySchema, 30),
  followUpQuestion: str(320),
  /** Exactly 3 short tappable answers (4 tolerated). */
  suggestions: tolerantArray(str(90, 1), 4),
});

export type AiReply = z.infer<typeof AiReplySchema>;
export type StructuredPlace = AiReply["places"][number];
export type ItineraryDay = AiReply["itinerary"][number];
export type ItineraryItem = ItineraryDay["items"][number];

export type ParseResult = { ok: true; reply: AiReply } | { ok: false; errors: string[] };

/**
 * Pull the reply object out of whatever the model produced: fenced or not,
 * leading chatter tolerated, trailing chatter ignored. String/escape aware so
 * a `}` inside a description can't truncate the object.
 */
export function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Enforce min ≤ typical ≤ max; keep the object valid for the UI. */
function tidyVisitDuration(d: VisitDuration | undefined): VisitDuration | undefined {
  if (!d) return undefined;
  const lo = Math.min(d.minMinutes, d.maxMinutes);
  const hi = Math.max(d.minMinutes, d.maxMinutes);
  const typical = Math.min(Math.max(d.typicalMinutes, lo), hi);
  return {
    minMinutes: lo,
    typicalMinutes: typical,
    maxMinutes: hi,
    confidence: d.confidence,
    basis: tidy(d.basis),
  };
}

/** Trim, de-duplicate and order what came back. Never mutates the input. */
export function normalizeReply(reply: AiReply): AiReply {
  const seen = new Set<string>();
  const places: StructuredPlace[] = [];
  for (const p of reply.places) {
    const key = tidy(p.name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    places.push({
      ...p,
      name: tidy(p.name),
      category: tidy(p.category).toLowerCase(),
      city: tidy(p.city),
      description: tidy(p.description),
      priceLevel: tidy(p.priceLevel),
      duration: tidy(p.duration),
      visitDuration: tidyVisitDuration(p.visitDuration),
      cost: tidy(p.cost),
      openingHours: tidy(p.openingHours),
      source: tidy(p.source),
    });
  }

  const days = [...reply.itinerary]
    .sort((a, b) => a.day - b.day)
    .map((d) => ({
      ...d,
      title: tidy(d.title),
      items: d.items.map((it) => ({
        ...it,
        time: tidy(it.time),
        title: tidy(it.title),
        description: tidy(it.description),
        place: tidy(it.place),
        duration: tidy(it.duration),
        cost: tidy(it.cost),
        openingHours: tidy(it.openingHours),
      })),
    }));

  const suggestions: string[] = [];
  for (const s of reply.suggestions) {
    const v = tidy(s);
    if (v && !suggestions.includes(v)) suggestions.push(v);
    if (suggestions.length >= 4) break;
  }

  const destinationText = tidy(reply.destination);
  const datesText = tidy(reply.dates);
  const destinationIsWindow = destinationText.length > 0 && isTravelWindow(destinationText);

  return {
    intro: tidy(reply.intro),
    destination: destinationIsWindow ? "" : destinationText,
    dates: destinationIsWindow && !datesText ? destinationText : datesText,
    places,
    itinerary: days,
    followUpQuestion: tidy(reply.followUpQuestion),
    suggestions,
  };
}

/** Parse + validate a raw model reply. Errors are safe to feed back to a retry. */
export function parseAiReply(raw: string): ParseResult {
  const json = extractJsonObject(raw);
  if (!json) {
    return { ok: false, errors: ["no JSON object found in the reply"] };
  }

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`JSON is malformed: ${msg.slice(0, 160)}`] };
  }

  const parsed = AiReplySchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
    return { ok: false, errors };
  }
  return { ok: true, reply: normalizeReply(parsed.data) };
}

/** Human-readable (and model-readable) summary of why a reply was rejected. */
export function formatRejection(errors: string[]): string {
  return errors.slice(0, 6).join("; ");
}
