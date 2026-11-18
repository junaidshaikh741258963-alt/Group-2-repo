package com.tripcraft.backend.rag;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Filter + dedupe + rerank — the port of {@code src/lib/rag/rank.ts}.
 *
 * <p>Runs after all retrievers returned. Nothing reaches the LLM without
 * passing through here: near-duplicate collapse first, then a blended
 * relevance score (retriever confidence + lexical fit + source priority),
 * then per-source caps so one noisy source can't flood the context.
 */
public final class Rank {

    private Rank() {
    }

    /** Source priority for context ordering / tie-breaks. */
    private static final Map<RetrievalSource, Double> SOURCE_WEIGHT = new EnumMap<>(RetrievalSource.class);

    static {
        SOURCE_WEIGHT.put(RetrievalSource.MEMORY, 1.0);
        SOURCE_WEIGHT.put(RetrievalSource.PREFERENCES, 0.95);
        SOURCE_WEIGHT.put(RetrievalSource.LIVE, 0.95);
        SOURCE_WEIGHT.put(RetrievalSource.KNOWLEDGE, 0.85);
        SOURCE_WEIGHT.put(RetrievalSource.WEB, 0.75);
    }

    private static final Map<RetrievalSource, Integer> PER_SOURCE_CAP = new EnumMap<>(RetrievalSource.class);

    static {
        PER_SOURCE_CAP.put(RetrievalSource.MEMORY, 3);
        PER_SOURCE_CAP.put(RetrievalSource.PREFERENCES, 4);
        PER_SOURCE_CAP.put(RetrievalSource.LIVE, 5);
        PER_SOURCE_CAP.put(RetrievalSource.KNOWLEDGE, 3);
        PER_SOURCE_CAP.put(RetrievalSource.WEB, 2);
    }

    public static final int MAX_CONTEXT_DOCS = 8;

    /** Below this a doc is treated as unrelated — dropped, not passed along. */
    private static final double MIN_FINAL_SCORE = 0.25;

    /**
     * Knowledge/web docs must clearly touch the question's terms (genuine
     * matches land ≥ 0.23, noise ~0.12 — so the floor is 0.15). Exported
     * because the knowledge retriever fires its web fallback on the SAME
     * criterion, or rank could empty a context the retriever trusted.
     */
    public static final double KNOWLEDGE_LEXICAL_MIN = 0.15;

    public static double sourceWeight(RetrievalSource source) {
        Double weight = SOURCE_WEIGHT.get(source);
        return weight == null ? 0.5 : weight;
    }

    /** Collapse exact and near duplicates (Jaccard ≥ 0.8 on content tokens). */
    public static List<RetrievedDoc> dedupe(List<RetrievedDoc> docs) {
        List<RetrievedDoc> kept = new ArrayList<>();
        List<List<String>> keptTokenSets = new ArrayList<>();
        Map<String, Boolean> seenText = new LinkedHashMap<>();
        List<RetrievedDoc> sorted = new ArrayList<>(docs);
        sorted.sort((a, b) -> Double.compare(b.score() == null ? 0 : b.score(),
                a.score() == null ? 0 : a.score()));

        for (RetrievedDoc doc : sorted) {
            String textKey = (doc.title() + "\n" + doc.text()).toLowerCase(java.util.Locale.ROOT)
                    .replaceAll("[^a-z0-9]+", " ").trim();
            if (textKey.isEmpty() || seenText.containsKey(textKey)) {
                continue;
            }
            List<String> tokens = Tokenizer.significantTokens(doc.title() + " " + doc.text());
            boolean nearDup = false;
            for (List<String> keptTokens : keptTokenSets) {
                if (Tokenizer.jaccard(keptTokens, tokens) >= 0.8) {
                    nearDup = true;
                    break;
                }
            }
            if (nearDup) {
                continue;
            }
            seenText.put(textKey, Boolean.TRUE);
            keptTokenSets.add(tokens);
            kept.add(doc);
        }
        return kept;
    }

    /** Blended final score: retriever confidence + lexical fit + source priority. */
    public static List<RetrievedDoc> rerank(List<RetrievedDoc> docs, String question) {
        List<RetrievedDoc> out = new ArrayList<>();
        for (RetrievedDoc doc : docs) {
            double base = doc.score() == null ? 0.5 : doc.score();
            double lexical = Tokenizer.overlapScore(question, doc.title() + " " + doc.text());
            double weight = sourceWeight(doc.source());
            double score = 0.55 * clamp01(base) + 0.3 * lexical + 0.15 * weight;
            RetrievedDoc copy = new RetrievedDoc(doc);
            copy.score(score);
            copy.lexical(lexical);
            out.add(copy);
        }
        out.removeIf(doc -> doc.score() < MIN_FINAL_SCORE);
        out.sort((a, b) -> Double.compare(b.score(), a.score()));
        return out;
    }

    /**
     * Whether a knowledge/web doc may enter the context pool, and why not:
     * {@code "entity"} when the question names proper nouns the doc does not
     * touch, {@code "lexical"} when the doc does not touch the question's
     * terms, {@code null} when it may enter. Gated docs stay in the ranked
     * list for diagnostics, tagged {@code meta.gated} with the reason.
     */
    public static String knowledgeGateReason(RetrievedDoc doc, String question) {
        if (doc.source() != RetrievalSource.KNOWLEDGE && doc.source() != RetrievalSource.WEB) {
            return null;
        }
        boolean hasQuestion = question != null && !question.isEmpty();
        if (hasQuestion) {
            List<String> entities = Tokenizer.entityTokens(question);
            if (!entities.isEmpty()) {
                String hay = (doc.title() + " " + doc.text()).toLowerCase(java.util.Locale.ROOT);
                boolean touches = false;
                for (String entity : entities) {
                    if (hay.contains(entity)) {
                        touches = true;
                        break;
                    }
                }
                if (!touches) {
                    return "entity";
                }
            }
        }
        double lexical = doc.lexical() == null ? 0 : doc.lexical();
        if (lexical >= KNOWLEDGE_LEXICAL_MIN) {
            return null;
        }
        if (!hasQuestion) {
            return "lexical";
        }
        return Tokenizer.queryTokens(question).size() <= 2 && lexical > 0 ? null : "lexical";
    }

    /**
     * Per-source caps, preserving rerank order — but reserving one slot per
     * represented source first, so five live hits can't crowd user-specific
     * memory/preferences out of an 8-doc context.
     */
    public static List<RetrievedDoc> selectTop(List<RetrievedDoc> docs) {
        Map<RetrievalSource, Integer> counts = new EnumMap<>(RetrievalSource.class);
        List<RetrievedDoc> picked = new ArrayList<>();
        java.util.Set<RetrievalSource> represented = java.util.EnumSet.noneOf(RetrievalSource.class);
        boolean[] isPicked = new boolean[docs.size()];

        for (int i = 0; i < docs.size(); i++) {
            if (picked.size() >= MAX_CONTEXT_DOCS) {
                break;
            }
            RetrievedDoc doc = docs.get(i);
            if (represented.contains(doc.source())) {
                continue;
            }
            represented.add(doc.source());
            counts.put(doc.source(), 1);
            isPicked[i] = true;
            picked.add(doc);
        }
        for (int i = 0; i < docs.size(); i++) {
            if (picked.size() >= MAX_CONTEXT_DOCS) {
                break;
            }
            if (isPicked[i]) {
                continue;
            }
            RetrievedDoc doc = docs.get(i);
            int used = counts.getOrDefault(doc.source(), 0);
            int cap = PER_SOURCE_CAP.getOrDefault(doc.source(), 2);
            if (used >= cap) {
                continue;
            }
            counts.put(doc.source(), used + 1);
            isPicked[i] = true;
            picked.add(doc);
        }
        picked.sort((a, b) -> Double.compare(b.score() == null ? 0 : b.score(),
                a.score() == null ? 0 : a.score()));
        return picked;
    }

    /**
     * Dedupe + rerank, WITHOUT allocating context slots: the caller has to run
     * {@link #knowledgeGateReason} first, otherwise gated docs consume slots
     * that a legit doc then can't have.
     */
    public static List<RetrievedDoc> rankCandidates(List<RetrievedDoc> docs, String question) {
        return rerank(dedupe(docs), question);
    }

    private static double clamp01(double n) {
        return n < 0 ? 0 : n > 1 ? 1 : n;
    }
}
