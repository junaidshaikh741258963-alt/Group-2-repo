package com.tripcraft.backend.rag.knowledge;

/**
 * One entry of the bundled knowledge corpus — {@code KnowledgeDoc} in
 * {@code src/lib/rag/knowledge/corpus.ts}.
 *
 * @param id       stable slug used in retrieval doc ids
 * @param title    short human label
 * @param category grouping for diagnostics / meta
 * @param text     factual paragraph (the payload sent to the LLM)
 * @param tags     extra keywords / synonyms for recall
 */
public record KnowledgeDoc(String id, String title, String category, String text, String tags) {

    /** The haystack both indexes are built from. */
    public String haystack() {
        return title + ". " + text + " " + tags;
    }
}
