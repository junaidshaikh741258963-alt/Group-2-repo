/**
 * Client-side helpers for the structured AI reply (see `aiSchema.ts` for the
 * contract). Deliberately free of zod so this stays cheap in the bundle.
 */

import type { AiReply } from "./aiSchema";
import { coerceType, recMeta, type RecType, type Recommendation } from "../recommendations";
import {
  inferQuestionField,
  nextField,
  type PlanningField,
  type TripProfile,
} from "../tripProfile";

/** Presentation order: where you're going → what you do → where you eat → where you sleep. */
const CATEGORY_ORDER: RecType[] = ["destination", "attraction", "restaurant", "hotel"];

export interface CardGroup {
  type: RecType;
  label: string;
  color: string;
  items: Recommendation[];
}

/**
 * Group a reply's places by card category (destination / attraction /
 * restaurant / hotel) so each group renders as its own labelled strip.
 * Groups follow CATEGORY_ORDER; unknown labels fall back to "attraction".
 */
export function groupCardsByCategory(items: Recommendation[]): CardGroup[] {
  const buckets = new Map<RecType, Recommendation[]>();
  for (const item of items) {
    const bucket = buckets.get(item.type);
    if (bucket) bucket.push(item);
    else buckets.set(item.type, [item]);
  }
  const ordered = CATEGORY_ORDER.filter((t) => buckets.has(t));
  return ordered.map((type) => {
    const meta = recMeta(type);
    return { type, label: meta.label, color: meta.color, items: buckets.get(type)! };
  });
}

/**
 * Client-side backstop for the one-shelf rule.
 *
 * The server already reduces a reply to a single category, but stored
 * conversations and legacy payloads can contain an older mixed reply. Picking
 * the largest group (ties keep the first, which follows CATEGORY_ORDER) means
 * the UI can never show restaurants + hotels + sights side by side even if a
 * payload slips through.
 */
export function dominantCardGroup(groups: CardGroup[]): CardGroup | null {
  if (groups.length <= 1) return groups[0] ?? null;
  let best = groups[0];
  for (const group of groups.slice(1)) {
    if (group.items.length > best.items.length) best = group;
  }
  return best;
}

/**
 * Which stage chip answer the follow-up question belongs to, so tapping a chip
 * lands on the right profile field. Falls back to the stage machine when the
 * question doesn't map to one.
 */
export function deriveFieldFromReply(reply: AiReply, profile: TripProfile): PlanningField {
  const question = reply.followUpQuestion.trim();
  if (question) {
    const inferred = inferQuestionField(question);
    if (inferred) return inferred;
  }
  return nextField(profile);
}

/** The reply's chips, capped at three as per the prompt contract. */
export function replySuggestions(reply: AiReply): string[] {
  return reply.suggestions.slice(0, 3);
}

/** Map a raw `category` string from the model onto a card type. */
export function categoryToType(category: string): RecType {
  return coerceType(category);
}

/**
 * Compact "what is currently on the table" block echoed back on the next
 * request, so "make it cheaper" edits this plan instead of starting over.
 */
export function planSummary(reply: AiReply | null | undefined): string {
  if (!reply) return "";
  const lines: string[] = [];
  if (reply.destination) lines.push(`destination: ${reply.destination}`);
  if (reply.dates) lines.push(`dates: ${reply.dates}`);
  if (reply.places.length > 0) {
    lines.push(
      `places: ${reply.places
        .map((p) => {
          const facts = [p.city, p.priceLevel || p.cost, p.duration].filter(Boolean);
          return `${p.name}${facts.length ? ` (${facts.join(", ")})` : ""}`;
        })
        .join(", ")}`
    );
  }
  for (const day of reply.itinerary) {
    const stops = day.items
      .map((i) => [i.title, i.duration, i.cost].filter(Boolean).join(" · "))
      .filter(Boolean);
    if (stops.length > 0) lines.push(`day ${day.day}: ${stops.join(" → ")}`);
  }
  if (reply.followUpQuestion) lines.push(`last question asked: ${reply.followUpQuestion}`);
  return lines.join("\n");
}

/**
 * Fold what the model learned this turn back into the trip context, so the
 * next request never re-asks for the destination or the dates.
 *
 * Returns the SAME object when nothing changed (cheap identity check — the
 * chat page writes the profile after every message).
 */
export function mergeProfileFromReply<
  T extends { destination: string | null; dates: string | null },
>(profile: T, reply: AiReply): T {
  const destination = reply.destination.trim() || null;
  const dates = reply.dates.trim() || null;
  if (destination === profile.destination && dates === profile.dates) return profile;
  return {
    ...profile,
    destination: destination ?? profile.destination,
    dates: dates ?? profile.dates,
  };
}
