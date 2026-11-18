/**
 * Conversation/trip memory retriever — pure, no I/O.
 *
 * Selects only the turns that are actually relevant to a recollection-style
 * question. Every candidate must share content tokens with the question; the
 * single exception is a fallback to the most recent user answers when the
 * question is explicitly about a choice/pick ("What did I choose?"), because
 * the recent answers literally *are* the choices.
 */

import type { RetrievedDoc, RetrievalContext } from "../types";
import { clip, overlapScore, queryTokens } from "../tokenize";

const MIN_SCORE = 0.1;
const CHOICE_RE =
  /\b(chose|choose|chosen|pick|picked|decided|decision|selected|selection|settled|went with|preferred)\b/i;

export function retrieveMemory(ctx: RetrievalContext): RetrievedDoc[] {
  const { question, turns } = ctx;
  if (turns.length === 0) return [];

  const scored: RetrievedDoc[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const text = clip(t.content, 600);
    if (!text) continue;
    const score = overlapScore(question, text);
    if (score < MIN_SCORE) continue;
    const recency = turns.length <= 1 ? 1 : i / (turns.length - 1);
    scored.push({
      id: `memory-${i}`,
      source: "memory",
      title: t.role === "user" ? "You said earlier in this conversation" : "Assistant said earlier",
      text,
      score: score * (0.75 + 0.25 * recency),
      recency,
      meta: { turn: String(i + 1) },
    });
  }

  // Fallback for bare choice questions: the latest user answers are the picks.
  if (scored.length < 2 && CHOICE_RE.test(question)) {
    const recent = [...turns.entries()].filter(([, t]) => t.role === "user").slice(-2);
    for (const [i, t] of recent) {
      if (scored.some((d) => d.id === `memory-${i}`)) continue;
      const text = clip(t.content, 600);
      if (!text) continue;
      scored.push({
        id: `memory-${i}`,
        source: "memory",
        title: "Your most recent answer",
        text,
        score: 0.5,
        recency: turns.length <= 1 ? 1 : i / (turns.length - 1),
        meta: { turn: String(i + 1) },
      });
    }
  }

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, 6);
}

/** Sanity helper used by /api/rag diagnostics. */
export function memoryQueryTokens(question: string): string[] {
  return queryTokens(question);
}
