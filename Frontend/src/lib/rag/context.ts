/**
 * Grounded context builder + the source footer appended to the streamed reply.
 *
 * Every doc that reaches the prompt gets a stable [Sn] id; the same ids appear
 * in the user-visible "Sources" line, so answers are auditable.
 */

import type { RetrievedDoc, RetrievalPlan, RetrievalSource, SourceRef } from "./types";
import { clip } from "./tokenize";

const SOURCE_ORDER: RetrievalSource[] = ["memory", "preferences", "live", "knowledge", "web"];

const SOURCE_HEADING: Record<RetrievalSource, string> = {
  memory: "Conversation memory (earlier in this chat)",
  preferences: "Your saved preferences and trip board",
  live: "Live travel data (checked just now)",
  knowledge: "Travel knowledge base",
  web: "Web results",
};

const DEFAULT_ORIGIN: Record<RetrievalSource, string> = {
  memory: "this conversation",
  preferences: "your saved context",
  live: "live search",
  knowledge: "knowledge base",
  web: "web search",
};

const DOC_CLIP = 420;
/**
 * Hard size cap for the whole retrieval block (~650 tokens). The free tier
 * bills roughly 200k tokens per DAY, so an unbounded context is a real
 * budget line: the highest-ranked docs win, and we always keep at least three
 * so grounding is never traded away entirely.
 */
const CONTEXT_CHAR_BUDGET = 2_600;

export interface BuiltContext {
  /** Block appended to the system prompt (empty only if nothing was planned). */
  contextBlock: string;
  sources: SourceRef[];
}

const GROUNDING_RULES = `### Retrieved context (ground this reply)
Grounding rules:
- Answer from the context below wherever it is relevant, and cite sources inline as [S1], [S2].
- Any fact, price, rating, review or place detail must come from this context — never invent one.
- If the context does not cover what the user asked, say plainly that you couldn't find reliable information instead of guessing.
- Live entries were checked just now, but availability and prices can still change.
- Use only the entries that help answer the user's LATEST message; never dump the whole list.
- Everything else in this prompt still applies (structured JSON reply, turn limits, no repeats).`;

export function buildContext(docsIn: RetrievedDoc[], plan: RetrievalPlan): BuiltContext {
  if (plan.sources.length === 0) return { contextBlock: "", sources: [] };

  // Group by source (stable order), preserving rerank order inside a group.
  const docs = [...docsIn].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
  );

  const sources: SourceRef[] = [];
  const lines: string[] = [];
  let lastSource: RetrievalSource | null = null;
  let charsUsed = 0;

  docs.forEach((doc) => {
    const body = clip(doc.text, DOC_CLIP);
    // Budget already spent (but we always keep a minimum of three docs).
    if (sources.length >= 3 && charsUsed + body.length > CONTEXT_CHAR_BUDGET) return;
    charsUsed += body.length + 24;
    const id = `S${sources.length + 1}`;
    const origin = doc.meta?.origin ?? DEFAULT_ORIGIN[doc.source];
    sources.push({
      id,
      source: doc.source,
      label: clip(doc.title, 48),
      origin,
      url: doc.meta?.url,
    });
    if (doc.source !== lastSource) {
      lines.push(`\n${SOURCE_HEADING[doc.source]}:`);
      lastSource = doc.source;
    }
    lines.push(`[${id}] ${body}`);
  });

  const missingLive =
    plan.sources.includes("live") && !docs.some((d) => d.source === "live")
      ? "\nLive search returned nothing for this question — do not quote current prices, availability or opening hours; suggest the user run a live search."
      : "";

  let contextBlock: string;
  if (docs.length === 0) {
    // Planned retrieval, but nothing passed relevance — the model must not fill
    // the gap with invented specifics.
    const liveNote = plan.sources.includes("live")
      ? " Live search also returned nothing, so current prices or availability must not be stated."
      : "";
    contextBlock =
      `\n\n${GROUNDING_RULES.replace("(ground this reply)", "— nothing relevant was found")}` +
      `\nNo reliable context could be retrieved for this question. Do not state facts, prices, ratings or places you cannot verify from this conversation; say that you couldn't find reliable information.${liveNote}`;
  } else {
    contextBlock = `\n\n${GROUNDING_RULES}\n${lines.join("\n")}${missingLive}`;
  }

  return { contextBlock, sources };
}

/** User-visible footer inserted just before the machine-readable tags. */
export function buildSourcesFooter(sources: SourceRef[]): string {
  if (sources.length === 0) return "";
  const parts = sources.map((s) =>
    s.url ? `[${s.id}] [${s.label}](${s.url})` : `[${s.id}] ${s.label} · ${s.origin}`
  );
  return `\n\n---\n**Sources:** ${parts.join(" · ")}`;
}
