/**
 * Hybrid knowledge store: BM25 (lexical) + vector cosine (semantic) over the
 * curated corpus plus the ingested Wikivoyage snapshot
 * (`.data/rag-corpus.json`, written by `node scripts/ingest-knowledge.mts`).
 *
 * Built lazily once per process, then reused — searching costs zero external
 * API calls. Scoring is deliberately robust against corpus growth:
 *   · lexical leg: saturating normalisation `raw / (raw + LEX_HALF)` — no
 *     build-time ceiling to drift as the corpus changes;
 *   · semantic leg: gated by a cosine floor so hashed-n-gram noise (a flat
 *     ~0.4 wall) can never outrank a solid lexical match. See
 *     `.data/eval-report.txt` and `tests/eval/` for the measurements.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clip, significantTokens } from "../tokenize";
import { Bm25Index } from "../store/bm25";
import { VectorIndex } from "../store/vectorIndex";
import { KNOWLEDGE_CORPUS, type KnowledgeDoc } from "./corpus";

export interface KnowledgeHit {
  doc: KnowledgeDoc;
  /** Blended hybrid score. Interpreted relative to `minScore` only. */
  score: number;
}

interface Store {
  bm25: Bm25Index<KnowledgeDoc>;
  vectors: VectorIndex<KnowledgeDoc>;
  /** Curated + ingested docs, stable order for scoring iteration. */
  docs: KnowledgeDoc[];
}

let store: Store | null = null;

interface IngestedCorpus {
  generatedAt?: string;
  docs?: KnowledgeDoc[];
}

/**
 * Ingested Wikivoyage corpus, written by `node scripts/ingest-knowledge.mts`.
 * Missing or corrupt file degrades to the curated corpus alone — never throws.
 */
function loadIngested(): KnowledgeDoc[] {
  try {
    const raw = readFileSync(join(process.cwd(), ".data", "rag-corpus.json"), "utf8");
    const parsed = JSON.parse(raw) as IngestedCorpus;
    if (!Array.isArray(parsed.docs)) return [];
    return parsed.docs.filter(
      (d) =>
        d && typeof d.id === "string" && typeof d.title === "string" && typeof d.text === "string"
    );
  } catch {
    return [];
  }
}

function buildStore(): Store {
  const docs = [...KNOWLEDGE_CORPUS, ...loadIngested()];
  const bm25 = new Bm25Index<KnowledgeDoc>();
  const vectors = new VectorIndex<KnowledgeDoc>();
  for (const doc of docs) {
    const haystack = `${doc.title}. ${doc.text} ${doc.tags}`;
    // Index significant tokens only. Indexing stopwords let conversational
    // questions ("what should I know about…") accumulate ~8 raw BM25 points
    // on generic sections — a noise floor above real content matches.
    bm25.add(significantTokens(haystack), doc);
    vectors.add(doc, haystack);
  }
  return { bm25, vectors, docs };
}

function ensureStore(): Store {
  if (!store) store = buildStore();
  return store;
}

/** Blend weights + leg shape. Tuned against tests/eval reports. */
const W_LEXICAL = 0.7;
const W_SEMANTIC = 0.35;
/** Raw BM25 at which the lexical leg reaches half strength. */
const LEX_HALF = 12;
/** Cosine below this is hashed-n-gram noise — contributes nothing. */
const VEC_COS_FLOOR = 0.15;
/** Cosine at which the semantic leg saturates. */
const VEC_COS_FULL = 0.45;

/**
 * Search the knowledge base.
 *
 * @param query      natural-language question
 * @param k          max docs returned
 * @param minScore   below this the doc is considered irrelevant (tuned so
 *                   unrelated questions return nothing rather than filler)
 */
export function searchKnowledge(query: string, k = 4, minScore = 0.2): KnowledgeHit[] {
  const s = ensureStore();
  const q = query.trim();
  if (!q || significantTokens(q).length === 0) return [];
  return scoreDocs(q, s, k * 3)
    .filter((row) => row.score >= minScore)
    .slice(0, k)
    .map((row) => ({ doc: row.doc, score: row.score }));
}

export interface KnowledgeScoreRow {
  doc: KnowledgeDoc;
  /** Lexical (BM25) leg contribution after normalisation and weighting. */
  lexical: number;
  /** Semantic (vector) leg contribution after gating and weighting. */
  semantic: number;
  /** Blended score used for ranking. */
  score: number;
  /** Raw BM25 score (pre-normalisation). */
  lexicalRaw: number;
  /** Raw cosine similarity from the vector index. */
  cosine: number;
}

/**
 * Score every candidate for a query, exposing the legs separately.
 * Diagnostics only (probes/evals) — the chat pipeline uses `searchKnowledge`.
 */
export function debugKnowledge(query: string, k = 12): KnowledgeScoreRow[] {
  const s = ensureStore();
  const q = query.trim();
  if (!q || significantTokens(q).length === 0) return [];
  return scoreDocs(q, s, Math.max(k * 3, 36)).slice(0, k);
}

function scoreDocs(q: string, s: Store, wide: number): KnowledgeScoreRow[] {
  const lexical = s.bm25.search(q, wide);
  const semantic = s.vectors.search(q, wide);

  const rows = new Map<string, KnowledgeScoreRow>();
  for (const hit of lexical) {
    const norm = hit.score / (hit.score + LEX_HALF);
    rows.set(hit.item.id, {
      doc: hit.item,
      lexical: W_LEXICAL * norm,
      semantic: 0,
      score: W_LEXICAL * norm,
      lexicalRaw: hit.score,
      cosine: 0,
    });
  }
  for (const hit of semantic) {
    const cos = hit.score;
    const norm = Math.min(1, Math.max(0, (cos - VEC_COS_FLOOR) / (VEC_COS_FULL - VEC_COS_FLOOR)));
    const row = rows.get(hit.item.id) ?? {
      doc: hit.item,
      lexical: 0,
      semantic: 0,
      score: 0,
      lexicalRaw: 0,
      cosine: cos,
    };
    row.cosine = cos;
    row.semantic = W_SEMANTIC * norm;
    row.score = row.lexical + row.semantic;
    rows.set(hit.item.id, row);
  }

  return [...rows.values()].sort((a, b) => b.score - a.score);
}

/** Exposed for diagnostics (/api/rag) — never ships to the LLM directly. */
export function knowledgeCorpusSize(): number {
  const s = ensureStore();
  return s.docs.length;
}

/** Curated vs ingested breakdown for diagnostics. */
export function knowledgeStats(): { curated: number; ingested: number } {
  const docs = ensureStore().docs;
  const ingested = docs.filter((d) => d.source === "wikivoyage").length;
  return { curated: docs.length - ingested, ingested };
}

export function knowledgeSnippet(doc: KnowledgeDoc, max = 700): string {
  return clip(`${doc.title}. ${doc.text}`, max);
}
