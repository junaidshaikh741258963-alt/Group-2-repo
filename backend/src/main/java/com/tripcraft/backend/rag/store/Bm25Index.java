package com.tripcraft.backend.rag.store;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.tripcraft.backend.rag.Tokenizer;

/**
 * Classic BM25 over pre-tokenized documents — the port of
 * {@code src/lib/rag/store/bm25.ts}.
 *
 * <p>Built once per process (knowledge corpus is static), searched in ~O(n)
 * per query. Returns a raw relevance score — normalisation happens in the
 * caller so BM25 can be blended with vector cosine (hybrid search).
 *
 * <p>The maths is literal: {@code k1 = 1.2}, {@code b = 0.75},
 * {@code idf = ln(1 + (n - df + 0.5) / (df + 0.5))}.
 */
public class Bm25Index<T> {

    /** A scored search hit. */
    public record Hit<T>(T item, double score) {
    }

    private static final class Entry<T> {
        final Map<String, Integer> tf = new LinkedHashMap<>();
        int len;
        final T item;

        Entry(T item) {
            this.item = item;
        }
    }

    private final List<Entry<T>> docs = new ArrayList<>();
    private final Map<String, Integer> df = new LinkedHashMap<>();
    private double avgLen = 0;

    private final double k1 = 1.2;
    private final double b = 0.75;

    public void add(List<String> tokens, T item) {
        Entry<T> doc = new Entry<>(item);
        for (String token : tokens) {
            doc.tf.merge(token, 1, Integer::sum);
        }
        for (String token : doc.tf.keySet()) {
            df.merge(token, 1, Integer::sum);
        }
        doc.len = tokens.size();
        docs.add(doc);
        int total = 0;
        for (Entry<T> d : docs) {
            total += d.len;
        }
        avgLen = total / (double) docs.size();
    }

    public void addText(String text, T item) {
        add(Tokenizer.tokenize(text), item);
    }

    public int size() {
        return docs.size();
    }

    /** Top-k hits ordered by BM25 score (desc). */
    public List<Hit<T>> search(String query, int k) {
        if (docs.isEmpty()) {
            return List.of();
        }
        List<String> qTokens = Tokenizer.unique(Tokenizer.tokenize(query));
        int n = docs.size();
        List<Hit<T>> hits = new ArrayList<>();

        for (Entry<T> doc : docs) {
            double score = 0;
            for (String qt : qTokens) {
                Integer tf = doc.tf.get(qt);
                if (tf == null) {
                    continue;
                }
                Integer dfValue = df.get(qt);
                int docFreq = dfValue == null ? 0 : dfValue;
                double idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
                double norm = tf * (k1 + 1)
                        / (tf + k1 * (1 - b + (b * doc.len) / (avgLen != 0 ? avgLen : 1)));
                score += idf * norm;
            }
            if (score > 0) {
                hits.add(new Hit<>(doc.item, score));
            }
        }
        hits.sort((a, c) -> Double.compare(c.score(), a.score()));
        return hits.size() > k ? new ArrayList<>(hits.subList(0, k)) : hits;
    }
}
