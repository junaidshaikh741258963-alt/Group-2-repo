/**
 * Minimal in-memory vector index (cosine similarity).
 *
 * Default embedder is a deterministic hashed bag-of-tokens/bigrams encoder —
 * zero API calls, zero latency, works offline. The `Embedder` interface is the
 * swap point: drop in an embedding API (Gemini/OpenAI/…) later by passing a
 * different function to `VectorIndex` without touching any caller.
 */

import { tokenize } from "../tokenize";

export const EMBED_DIM = 384;

export type Embedder = (text: string) => Float32Array;

/** FNV-1a — small, fast, stable across processes. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Hashed n-gram bag: each unigram and adjacent bigram votes for one of
 * EMBED_DIM buckets (with a sign bit to reduce collisions). Bigrams give the
 * vector some word-order sensitivity beyond pure bag-of-words.
 */
export const hashedEmbed: Embedder = (text: string) => {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenize(text);
  for (const t of tokens) {
    const h = fnv1a(t);
    const idx = h % EMBED_DIM;
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    vec[idx] += sign;
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    const h = fnv1a(`${tokens[i]} ${tokens[i + 1]}`);
    const idx = h % EMBED_DIM;
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    vec[idx] += sign * 0.5;
  }
  return l2Normalize(vec);
};

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalised
}

export interface VectorHit<T> {
  item: T;
  /** Cosine similarity in 0..1 (negative similarities clamp to 0). */
  score: number;
}

export class VectorIndex<T> {
  private readonly embed: Embedder;
  private readonly items: T[] = [];
  private readonly vectors: Float32Array[] = [];

  constructor(embed: Embedder = hashedEmbed) {
    this.embed = embed;
  }

  get size(): number {
    return this.items.length;
  }

  add(item: T, text: string): void {
    this.items.push(item);
    this.vectors.push(this.embed(text));
  }

  search(query: string, k: number): Array<VectorHit<T>> {
    if (this.items.length === 0) return [];
    const q = this.embed(query);
    const hits: Array<VectorHit<T>> = [];
    for (let i = 0; i < this.items.length; i++) {
      const score = cosine(q, this.vectors[i]);
      if (score > 0) hits.push({ item: this.items[i], score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
