/**
 * User-specific preference retriever — pure, no I/O.
 *
 * Two ingredients:
 *  1. explicit preference sentences mined from the conversation
 *     ("I'm vegetarian", "we never take early flights"),
 *  2. saved trip-board items (the things the user actually picked).
 *
 * The trip *profile* itself is NOT repeated here — the chat route already
 * puts it in every prompt.
 */

import type { RetrievedDoc, RetrievalContext, TripItemLite } from "../types";
import { clip, overlapScore, queryTokens } from "../tokenize";

/**
 * Preference statements, mined from a sentence boundary (start, end-of-
 * sentence punctuation, newline, or a comma clause). Must handle the
 * contracted forms people actually type — "I'm vegetarian", "I am
 * vegetarian", "I don't eat meat" — not just "I prefer / we never …".
 */
const PREF_LINE_RE =
  /(?:^|[.!?\n]|,\s)\s*((?:i|we)(?:['’]m|\s+am|\s+re)?\s+(?:prefer|like|love|always|never|only|want|need|hate|avoid|dislike|vegetarian|vegan|allergic to|don['’]?t eat|dont eat|won['’]?t)\b[^.!?\n]{0,130})/gi;

const MAX_PREF_LINES = 4;
const MAX_BOARD_ITEMS = 5;

function minePreferenceLines(ctx: RetrievalContext): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const t of ctx.turns) {
    for (const m of t.content.matchAll(PREF_LINE_RE)) {
      const line = clip(m[1], 150);
      const key = line.toLowerCase();
      if (!line || seen.has(key)) continue;
      seen.add(key);
      found.push(line);
      if (found.length >= MAX_PREF_LINES) return found;
    }
  }
  return found;
}

function itemText(item: TripItemLite): string {
  return [
    item.name,
    item.category ?? "",
    item.detail ?? "",
    item.description ?? "",
    item.price ? `price ${item.price}` : "",
    item.rating ? `rated ${item.rating} of 5` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function retrievePreferences(ctx: RetrievalContext): RetrievedDoc[] {
  const docs: RetrievedDoc[] = [];
  const qTokens = queryTokens(ctx.question);

  for (const line of minePreferenceLines(ctx)) {
    docs.push({
      id: `preferences-${docs.length}`,
      source: "preferences",
      title: "Your stated preference",
      text: line,
      score: 0.55 + 0.45 * overlapScore(ctx.question, line),
      recency: 1,
      meta: { origin: "from this conversation" },
    });
  }

  const items = ctx.tripItems.map((item, i) => {
    const text = itemText(item);
    const overlap = overlapScore(ctx.question, text);
    const matchesTokens = qTokens.length > 0 && queryTokens(text).some((t) => qTokens.includes(t));
    return { item, text, i, overlap, matchesTokens };
  });

  // Prefer items that match the question (or its destination); fall back to
  // the most recently saved ones so a recall question still has an answer.
  const matched = items.filter((x) => x.overlap > 0 || x.matchesTokens);
  const chosen = matched.length > 0 ? matched : [...items].sort((a, b) => b.i - a.i).slice(0, 3);
  const ordered = [...chosen].sort((a, b) => b.overlap - a.overlap).slice(0, MAX_BOARD_ITEMS);

  for (const x of ordered) {
    docs.push({
      id: `preferences-item-${x.i}`,
      source: "preferences",
      title: `On your trip board: ${x.item.name}`,
      text: clip(x.text, 320),
      score: 0.35 + 0.5 * x.overlap,
      recency: 1,
      meta: { category: x.item.category ?? "other", origin: "saved to your trip" },
    });
  }

  docs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return docs.slice(0, 8);
}
