package com.tripcraft.backend.rag;

import java.util.List;

/**
 * The result of one retrieval run — {@code RagOutcome} in
 * {@code src/lib/rag/types.ts}.
 */
public final class RagOutcome {

    private final RetrievalPlan plan;
    /** Reranked, deduplicated, top-k docs actually placed in the context. */
    private final List<RetrievedDoc> docs;
    /** System-prompt block. Empty string when nothing relevant was found. */
    private final String contextBlock;
    private final List<SourceRef> sources;
    private long durationMs;

    public RagOutcome(RetrievalPlan plan, List<RetrievedDoc> docs, String contextBlock,
                      List<SourceRef> sources, long durationMs) {
        this.plan = plan;
        this.docs = docs;
        this.contextBlock = contextBlock;
        this.sources = sources;
        this.durationMs = durationMs;
    }

    public static RagOutcome empty(RetrievalPlan plan, long durationMs) {
        return new RagOutcome(plan, List.of(), "", List.of(), durationMs);
    }

    public RetrievalPlan plan() {
        return plan;
    }

    public List<RetrievedDoc> docs() {
        return docs;
    }

    public String contextBlock() {
        return contextBlock;
    }

    public List<SourceRef> sources() {
        return sources;
    }

    public long durationMs() {
        return durationMs;
    }

    public void durationMs(long durationMs) {
        this.durationMs = durationMs;
    }
}
