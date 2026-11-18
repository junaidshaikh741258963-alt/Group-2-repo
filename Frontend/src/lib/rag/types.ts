/**
 * Shared types for the RAG pipeline.
 *
 * Pipeline: question → route → retrieve (per source) → dedupe → rerank →
 * grounded context → LLM → answer (+ source footer).
 */

import type { TripProfile } from "@/lib/tripProfile";

/** Where a retrieved document came from. Extend this union to add a source. */
export type RetrievalSource = "memory" | "preferences" | "knowledge" | "live" | "web";

export interface RetrievedDoc {
  /** Stable id inside one retrieval run (e.g. "live-2"). */
  id: string;
  source: RetrievalSource;
  /** Short human label, shown in the source footer (e.g. "Hotel Gracery Shinjuku"). */
  title: string;
  /** The factual payload sent to the LLM. */
  text: string;
  /** Ranking metadata filled in by the retriever / reranker. */
  score?: number;
  /** Question↔doc lexical overlap (diagnostics + the knowledge/web gate). */
  lexical?: number;
  /** 0..1 — how recent the doc is (memory turns decay, live data is 1). */
  recency?: number;
  /** Provenance for citations: url, provider, checked-at note, category… */
  meta?: Record<string, string>;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Trimmed trip-board item sent by the chat client (see /api/chat body). */
export interface TripItemLite {
  name: string;
  category?: string;
  price?: string;
  detail?: string;
  description?: string;
  rating?: number;
}

/** Everything a retriever may look at. */
export interface RetrievalContext {
  /** The user's current question (the last user turn). */
  question: string;
  /** Prior conversation turns, oldest → newest (meta blocks already stripped). */
  turns: ChatTurn[];
  /** Current trip profile (same object the chat route puts in the system prompt). */
  profile: TripProfile;
  /** Trip-board items the user has saved. */
  tripItems: TripItemLite[];
  conversationId?: string;
  /** Fixed per request so caches and recency stay consistent. */
  now: number;
}

/** What to fetch for this question — decided by the router BEFORE retrieval. */
export interface RetrievalPlan {
  sources: RetrievalSource[];
  /** Place name for live retrieval (from profile or the question), if resolvable. */
  place?: string;
  /** What kind of live fact is needed. */
  liveKind?: "hotel" | "food" | "sight" | "weather";
  /** Narrower Overpass/Nominatim query ("museums", "cafes", "beaches"). */
  liveQuery?: string;
  /** Budget cap parsed from the question, used to filter live results. */
  budget?: { amount: number; currency: string };
  /** Query handed to the knowledge store / web fallback. */
  knowledgeQuery?: string;
  /**
   * A named-place category request ("museums in Madrid", "hotels in Kyoto").
   * The place entity is already a strong grounding signal, so a same-entity
   * guide chunk may pass the knowledge gate even when the F1 lexical score of
   * a long question falls under the encyclopedic floor.
   */
  groundedRecommendation?: boolean;
  /** Short human-readable reason (surfaced in /api/rag diagnostics). */
  reason: string;
}

export interface SourceRef {
  id: string;
  source: RetrievalSource;
  label: string;
  /** Provider / location line for the footer (e.g. "live hotel search"). */
  origin: string;
  url?: string;
}

export interface RagOutcome {
  plan: RetrievalPlan;
  /** Reranked, deduplicated, top-k docs actually placed in the context. */
  docs: RetrievedDoc[];
  /** System-prompt block. Empty string when nothing relevant was found. */
  contextBlock: string;
  sources: SourceRef[];
  durationMs: number;
}

export const EMPTY_PLAN: RetrievalPlan = { sources: [], reason: "no retrieval needed" };

export function emptyOutcome(plan: RetrievalPlan = EMPTY_PLAN, durationMs = 0): RagOutcome {
  return { plan, docs: [], contextBlock: "", sources: [], durationMs };
}
