/**
 * Filter + dedupe + rerank.
 *
 * Runs after all retrievers returned. Nothing reaches the LLM without passing
 * through here: near-duplicate collapse first, then a blended relevance score
 * (retriever confidence + lexical fit + source priority), then per-source caps
 * so one noisy source can't flood the context.
 */

import type { RetrievedDoc, RetrievalSource } from "./types";
import { entityTokens, jaccard, overlapScore, queryTokens, significantTokens } from "./tokenize";

/** Source priority for context ordering / tie-breaks. */
const SOURCE_WEIGHT: Record<RetrievalSource, number> = {
  memory: 1.0,
  preferences: 0.95,
  live: 0.95,
  knowledge: 0.85,
  web: 0.75,
};

const PER_SOURCE_CAP: Record<RetrievalSource, number> = {
  memory: 3,
  preferences: 4,
  live: 5,
  knowledge: 3,
  web: 2,
};

export const MAX_CONTEXT_DOCS = 8;
/** Below this a doc is treated as unrelated — dropped, not passed along. */
const MIN_FINAL_SCORE = 0.25;
/**
 * Knowledge/web docs must clearly touch the question's terms. Measured on the
 * real corpus: genuine matches land ≥ 0.23, noise ("travel insurance" for
 * "what should I keep in mind") sits at 0.12 — so the floor is 0.15. Exported
 * because the knowledge retriever must fire its web fallback on the SAME
 * criterion, or rank could empty a context the retriever trusted.
 */
export const KNOWLEDGE_LEXICAL_MIN = 0.15;

/** Collapse exact and near duplicates (Jaccard ≥ 0.8 on content tokens). */
export function dedupe(docs: RetrievedDoc[]): RetrievedDoc[] {
  const kept: RetrievedDoc[] = [];
  const keptTokenSets: string[][] = [];
  const seenText = new Set<string>();
  const sorted = [...docs].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  for (const doc of sorted) {
    const textKey = `${doc.title}\n${doc.text}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!textKey || seenText.has(textKey)) continue;
    const tokens = significantTokens(`${doc.title} ${doc.text}`);
    const nearDup = keptTokenSets.some((s) => jaccard(s, tokens) >= 0.8);
    if (nearDup) continue;
    seenText.add(textKey);
    keptTokenSets.push(tokens);
    kept.push(doc);
  }
  return kept;
}

/** Blended final score: retriever confidence + lexical fit + source priority. */
export function rerank(docs: RetrievedDoc[], question: string): RetrievedDoc[] {
  return docs
    .map((doc) => {
      const base = doc.score ?? 0.5;
      const lexical = overlapScore(question, `${doc.title} ${doc.text}`);
      const weight = SOURCE_WEIGHT[doc.source] ?? 0.5;
      const score = 0.55 * clamp01(base) + 0.3 * lexical + 0.15 * weight;
      return { ...doc, score, lexical };
    })
    .filter((doc) => doc.score >= MIN_FINAL_SCORE)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Whether a knowledge/web doc may enter the context pool, and why not.
 *
 * Two checks, in order:
 *  1. ENTITY: if the question names proper nouns ("visa for Japan"), the doc
 *     must touch at least one of them — topic overlap alone would ground a
 *     Japan question on the India visa entry.
 *  2. LEXICAL: encyclopedic docs must at least touch the question's terms —
 *     prevents plausible-sounding but unrelated KB entries ("jet lag") from
 *     riding in on source priority alone.
 *
 * Gated docs stay in the ranked list for diagnostics, tagged `meta.gated` with
 * the returned reason. Returns `null` when the doc may enter the context.
 *
 * `question` lets a one- or two-term question pass on weaker lexical evidence:
 * it has nothing else to match on, so "the doc contains a significant term of
 * the question" IS the signal. Without it (diagnostics) the absolute floor
 * applies — but the entity check still runs, since the entity set is derived
 * from the same string.
 */
export function knowledgeGateReason(
  doc: RetrievedDoc,
  question?: string,
  opts: { allowEntityMatch?: boolean } = {}
): "lexical" | "entity" | null {
  if (doc.source !== "knowledge" && doc.source !== "web") return null;
  if (question) {
    const entities = entityTokens(question);
    if (entities.length > 0) {
      const hay = `${doc.title} ${doc.text}`.toLowerCase();
      if (!entities.some((e) => hay.includes(e))) return "entity";
      // A named-place category request ("museums in Madrid") has already
      // pinned the entity. Long guide chunks can still miss the F1 floor when
      // the question carries generic words ("find", "best"), so let a
      // same-entity doc through instead of emptying the context.
      if (opts.allowEntityMatch) return null;
    }
  }
  const lexical = doc.lexical ?? 0;
  if (lexical >= KNOWLEDGE_LEXICAL_MIN) return null;
  if (!question) return "lexical";
  return queryTokens(question).length <= 2 && lexical > 0 ? null : "lexical";
}

/**
 * Per-source caps, preserving rerank order — but reserving one slot per
 * represented source first, so five live hits can't crowd user-specific
 * memory/preferences out of an 8-doc context.
 */
export function selectTop(docs: RetrievedDoc[]): RetrievedDoc[] {
  const counts: Partial<Record<RetrievalSource, number>> = {};
  const picked: RetrievedDoc[] = [];
  const represented = new Set<RetrievalSource>();

  for (const doc of docs) {
    if (picked.length >= MAX_CONTEXT_DOCS) break;
    if (represented.has(doc.source)) continue;
    represented.add(doc.source);
    counts[doc.source] = 1;
    picked.push(doc);
  }
  for (const doc of docs) {
    if (picked.length >= MAX_CONTEXT_DOCS) break;
    if (picked.includes(doc)) continue;
    const used = counts[doc.source] ?? 0;
    const cap = PER_SOURCE_CAP[doc.source] ?? 2;
    if (used >= cap) continue;
    counts[doc.source] = used + 1;
    picked.push(doc);
  }
  return picked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Dedupe + rerank, WITHOUT allocating context slots.
 *
 * Deliberately stops short of `selectTop`: the caller has to run
 * `knowledgeGateReason` first, otherwise gated docs consume slots that a legit
 * doc then can't have — the gate looked applied but had no effect.
 */
export function rankCandidates(docs: RetrievedDoc[], question: string): RetrievedDoc[] {
  return rerank(dedupe(docs), question);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export { SOURCE_WEIGHT };
