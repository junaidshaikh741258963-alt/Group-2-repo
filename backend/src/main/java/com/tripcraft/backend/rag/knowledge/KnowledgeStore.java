package com.tripcraft.backend.rag.knowledge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.tripcraft.backend.rag.Tokenizer;
import com.tripcraft.backend.rag.store.Bm25Index;
import com.tripcraft.backend.rag.store.VectorIndex;

/**
 * Hybrid knowledge store: BM25 (lexical) + vector cosine (semantic) over the
 * bundled knowledge corpus — the port of {@code src/lib/rag/knowledge/store.ts}.
 *
 * <p>Built lazily once per process, then reused; searching costs zero
 * external API calls.
 */
public final class KnowledgeStore {

    /** A blended hybrid hit, normalised to 0..1. */
    public record KnowledgeHit(KnowledgeDoc doc, double score) {
    }

    private static final class Store {
        final Bm25Index<KnowledgeDoc> bm25 = new Bm25Index<>();
        final VectorIndex<KnowledgeDoc> vectors = new VectorIndex<>();
        /** Max raw BM25 score seen at build time, for normalisation. */
        double bm25Ceiling;
    }

    private static volatile Store store;

    private KnowledgeStore() {
    }

    private static Store ensureStore() {
        Store local = store;
        if (local == null) {
            synchronized (KnowledgeStore.class) {
                local = store;
                if (local == null) {
                    local = buildStore();
                    store = local;
                }
            }
        }
        return local;
    }

    private static Store buildStore() {
        Store s = new Store();
        for (KnowledgeDoc doc : KnowledgeCorpus.DOCS) {
            String haystack = doc.haystack();
            s.bm25.addText(haystack, doc);
            s.vectors.add(doc, haystack);
        }
        // Ceiling = best score of a "typical" self-query (the doc's own title+tags).
        double ceiling = 1;
        for (KnowledgeDoc doc : KnowledgeCorpus.DOCS) {
            List<Bm25Index.Hit<KnowledgeDoc>> top =
                    s.bm25.search(doc.title() + " " + doc.tags(), 1);
            double score = top.isEmpty() ? 0 : top.get(0).score();
            ceiling = Math.max(ceiling, score);
        }
        s.bm25Ceiling = ceiling;
        return s;
    }

    /**
     * Search the knowledge base.
     *
     * @param query    natural-language question
     * @param k        max docs returned
     * @param minScore below this the doc is considered irrelevant (tuned so
     *                 unrelated questions return nothing rather than filler)
     */
    public static List<KnowledgeHit> search(String query, int k, double minScore) {
        Store s = ensureStore();
        String q = query == null ? "" : query.trim();
        if (q.isEmpty() || Tokenizer.significantTokens(q).isEmpty()) {
            return List.of();
        }

        List<Bm25Index.Hit<KnowledgeDoc>> lexical = s.bm25.search(q, k * 3);
        List<VectorIndex.VectorHit<KnowledgeDoc>> semantic = s.vectors.search(q, k * 3);

        Map<String, Double> scores = new LinkedHashMap<>();
        // Normalise against the build-time ceiling (the score of a document
        // queried with its own title/tags), NOT against this query's own best
        // hit: absolute normalisation keeps a stray-term collision near zero
        // while a strong real query still clears `minScore`.
        double ceiling = Math.max(1, s.bm25Ceiling);
        for (Bm25Index.Hit<KnowledgeDoc> hit : lexical) {
            scores.put(hit.item().id(), 0.6 * Math.min(1, hit.score() / ceiling));
        }
        for (VectorIndex.VectorHit<KnowledgeDoc> hit : semantic) {
            // Vector cosine on hashed n-grams yields small values — rescale a touch.
            double prev = scores.getOrDefault(hit.item().id(), 0.0);
            scores.put(hit.item().id(), prev + 0.4 * Math.min(1, hit.score() * 4));
        }

        List<KnowledgeHit> hits = new ArrayList<>();
        for (KnowledgeDoc doc : KnowledgeCorpus.DOCS) {
            double score = scores.getOrDefault(doc.id(), 0.0);
            if (score >= minScore) {
                hits.add(new KnowledgeHit(doc, score));
            }
        }
        hits.sort((a, b) -> Double.compare(b.score(), a.score()));
        return hits.size() > k ? new ArrayList<>(hits.subList(0, k)) : hits;
    }

    /** TS default signature: {@code searchKnowledge(query, 4, 0.16)}. */
    public static List<KnowledgeHit> search(String query, int k) {
        return search(query, k, 0.16);
    }

    /** Exposed for diagnostics (/api/rag) — never ships to the LLM directly. */
    public static int corpusSize() {
        return KnowledgeCorpus.DOCS.size();
    }

    public static String snippet(KnowledgeDoc doc, int max) {
        return Tokenizer.clip(doc.title() + ". " + doc.text(), max);
    }
}
