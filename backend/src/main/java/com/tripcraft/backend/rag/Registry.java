package com.tripcraft.backend.rag;

import java.util.List;

import org.springframework.stereotype.Component;

import com.tripcraft.backend.rag.retrievers.KnowledgeRetriever;
import com.tripcraft.backend.rag.retrievers.LiveRetriever;
import com.tripcraft.backend.rag.retrievers.MemoryRetriever;
import com.tripcraft.backend.rag.retrievers.PreferencesRetriever;

/**
 * Retriever registry — the single place to plug a new source in, the port of
 * {@code src/lib/rag/registry.ts}.
 *
 * <p>Add a {@link RetrievalSource}, implement the retriever, register it here
 * and add it to the router's PRIORITY list. Nothing else in the pipeline needs
 * changes. The two Spring-managed retrievers are injected; memory and
 * preferences are pure functions.
 */
@Component
public class Registry {

    private final KnowledgeRetriever knowledge;
    private final LiveRetriever live;

    public Registry(KnowledgeRetriever knowledge, LiveRetriever live) {
        this.knowledge = knowledge;
        this.live = live;
    }

    /** One pipeline leg for one source — TS {@code RETRIEVERS[source](ctx, plan)}. */
    public List<RetrievedDoc> retrieve(RetrievalSource source, RetrievalContext ctx, RetrievalPlan plan) {
        switch (source) {
            case MEMORY:
                return MemoryRetriever.retrieve(ctx);
            case PREFERENCES:
                return PreferencesRetriever.retrieve(ctx);
            case KNOWLEDGE:
                return knowledge.retrieve(plan);
            case LIVE:
                return live.retrieve(plan);
            case WEB:
            default:
                // "web" is produced inside the knowledge retriever as a fallback
                // (it only makes sense after the local knowledge base missed).
                return List.of();
        }
    }
}
