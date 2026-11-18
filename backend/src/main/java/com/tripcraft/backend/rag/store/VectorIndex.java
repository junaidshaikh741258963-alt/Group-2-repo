package com.tripcraft.backend.rag.store;

import java.util.ArrayList;
import java.util.List;

import com.tripcraft.backend.rag.Tokenizer;

/**
 * Minimal in-memory vector index (cosine similarity) — the port of
 * {@code src/lib/rag/store/vectorIndex.ts}.
 *
 * <p>The default embedder is a deterministic hashed bag-of-tokens/bigrams
 * encoder — zero API calls, zero latency, works offline.
 */
public class VectorIndex<T> {

    /** A scored search hit (cosine similarity in 0..1, negatives clamped). */
    public record VectorHit<T>(T item, double score) {
    }

    /** Swappable embedder — drop in an embedding API later. */
    @FunctionalInterface
    public interface Embedder {
        float[] embed(String text);
    }

    public static final int EMBED_DIM = 384;

    private final Embedder embed;
    private final List<T> items = new ArrayList<>();
    private final List<float[]> vectors = new ArrayList<>();

    public VectorIndex() {
        this(VectorIndex::hashedEmbed);
    }

    public VectorIndex(Embedder embed) {
        this.embed = embed;
    }

    public int size() {
        return items.size();
    }

    public void add(T item, String text) {
        items.add(item);
        vectors.add(embed.embed(text));
    }

    public List<VectorHit<T>> search(String query, int k) {
        if (items.isEmpty()) {
            return List.of();
        }
        float[] q = embed.embed(query);
        List<VectorHit<T>> hits = new ArrayList<>();
        for (int i = 0; i < items.size(); i++) {
            double score = cosine(q, vectors.get(i));
            if (score > 0) {
                hits.add(new VectorHit<>(items.get(i), score));
            }
        }
        hits.sort((a, c) -> Double.compare(c.score(), a.score()));
        return hits.size() > k ? new ArrayList<>(hits.subList(0, k)) : hits;
    }

    /** FNV-1a — small, fast, stable across processes. */
    private static int fnv1a(String str) {
        int h = 0x811c9dc5;
        for (int i = 0; i < str.length(); i++) {
            h ^= str.charAt(i);
            // JS `Math.imul(h, PRIME)`: Java's int multiply wraps the same way.
            h = h * 0x01000193;
        }
        return h;
    }

    private static float[] l2Normalize(float[] vec) {
        double sum = 0;
        for (float v : vec) {
            sum += v * v;
        }
        double norm = Math.sqrt(sum);
        if (norm > 0) {
            for (int i = 0; i < vec.length; i++) {
                vec[i] = (float) (vec[i] / norm);
            }
        }
        return vec;
    }

    /**
     * Hashed n-gram bag: each unigram and adjacent bigram votes for one of
     * {@link #EMBED_DIM} buckets (with a sign bit to reduce collisions).
     */
    public static float[] hashedEmbed(String text) {
        float[] vec = new float[EMBED_DIM];
        List<String> tokens = Tokenizer.tokenize(text);
        for (String token : tokens) {
            int h = fnv1a(token);
            int idx = (int) ((h & 0xFFFFFFFFL) % EMBED_DIM);
            vec[idx] += h < 0 ? -1 : 1;
        }
        for (int i = 0; i + 1 < tokens.size(); i++) {
            int h = fnv1a(tokens.get(i) + " " + tokens.get(i + 1));
            int idx = (int) ((h & 0xFFFFFFFFL) % EMBED_DIM);
            vec[idx] += h < 0 ? -0.5f : 0.5f;
        }
        return l2Normalize(vec);
    }

    /** Cosine of two L2-normalised vectors (dot product). */
    public static double cosine(float[] a, float[] b) {
        double dot = 0;
        int len = Math.min(a.length, b.length);
        for (int i = 0; i < len; i++) {
            dot += a[i] * b[i];
        }
        return dot;
    }
}
