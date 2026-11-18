/**
 * Classic BM25 over pre-tokenized documents.
 *
 * Built once per process (knowledge corpus is static), searched in ~O(n) per
 * query. Returns a raw relevance score — normalisation happens in the caller
 * so BM25 can be blended with vector cosine (hybrid search).
 */

import { tokenize } from "../tokenize";

export interface Bm25Doc<T> {
  tokens: string[];
  item: T;
}

export class Bm25Index<T> {
  private docs: Array<{ tf: Map<string, number>; len: number; item: T }> = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(tokens: string[], item: T): void {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push({ tf, len: tokens.length, item });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length;
  }

  addText(text: string, item: T): void {
    this.add(tokenize(text), item);
  }

  get size(): number {
    return this.docs.length;
  }

  /** Top-k hits ordered by BM25 score (desc). */
  search(query: string, k: number): Array<{ item: T; score: number }> {
    if (this.docs.length === 0) return [];
    const qTokens = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const hits: Array<{ item: T; score: number }> = [];

    for (const doc of this.docs) {
      let score = 0;
      for (const qt of qTokens) {
        const tf = doc.tf.get(qt);
        if (!tf) continue;
        const df = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + (this.b * doc.len) / (this.avgLen || 1)));
        score += idf * norm;
      }
      if (score > 0) hits.push({ item: doc.item, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
