package com.tripcraft.backend.rag;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Grounded context builder + the user-visible source footer — the port of
 * {@code src/lib/rag/context.ts}.
 *
 * <p>Every doc that reaches the prompt gets a stable {@code [Sn]} id; the same
 * ids appear in the "Sources" line, so answers are auditable.
 */
public final class ContextBuilder {

    private ContextBuilder() {
    }

    /** Order the sources are grouped in when the context block is assembled. */
    private static final List<RetrievalSource> SOURCE_ORDER = List.of(
            RetrievalSource.MEMORY, RetrievalSource.PREFERENCES, RetrievalSource.LIVE,
            RetrievalSource.KNOWLEDGE, RetrievalSource.WEB);

    private static final Map<RetrievalSource, String> SOURCE_HEADING = new EnumMap<>(RetrievalSource.class);

    static {
        SOURCE_HEADING.put(RetrievalSource.MEMORY, "Conversation memory (earlier in this chat)");
        SOURCE_HEADING.put(RetrievalSource.PREFERENCES, "Your saved preferences and trip board");
        SOURCE_HEADING.put(RetrievalSource.LIVE, "Live travel data (checked just now)");
        SOURCE_HEADING.put(RetrievalSource.KNOWLEDGE, "Travel knowledge base");
        SOURCE_HEADING.put(RetrievalSource.WEB, "Web results");
    }

    private static final Map<RetrievalSource, String> DEFAULT_ORIGIN = new EnumMap<>(RetrievalSource.class);

    static {
        DEFAULT_ORIGIN.put(RetrievalSource.MEMORY, "this conversation");
        DEFAULT_ORIGIN.put(RetrievalSource.PREFERENCES, "your saved context");
        DEFAULT_ORIGIN.put(RetrievalSource.LIVE, "live search");
        DEFAULT_ORIGIN.put(RetrievalSource.KNOWLEDGE, "knowledge base");
        DEFAULT_ORIGIN.put(RetrievalSource.WEB, "web search");
    }

    private static final int DOC_CLIP = 420;

    /**
     * Hard size cap for the whole retrieval block (~650 tokens). The highest
     * ranked docs win, and at least three always stay so grounding is never
     * traded away entirely.
     */
    private static final int CONTEXT_CHAR_BUDGET = 2600;

    /** The block appended to the system prompt. */
    private static final String GROUNDING_RULES = """
            ### Retrieved context (ground this reply)
            Grounding rules:
            - Answer from the context below wherever it is relevant, and cite sources inline as [S1], [S2].
            - Any fact, price, rating, review or place detail must come from this context — never invent one.
            - If the context does not cover what the user asked, say plainly that you couldn't find reliable information instead of guessing.
            - Live entries were checked just now, but availability and prices can still change.
            - Use only the entries that help answer the user's LATEST message; never dump the whole list.
            - Everything else in this prompt still applies (structured JSON reply, turn limits, no repeats).""";

    /** What {@link #buildContext} produced. */
    public record BuiltContext(String contextBlock, List<SourceRef> sources) {
    }

    public static BuiltContext buildContext(List<RetrievedDoc> docsIn, RetrievalPlan plan) {
        if (plan.sources().isEmpty()) {
            return new BuiltContext("", List.of());
        }

        // Group by source (stable order), preserving rerank order inside a group.
        List<RetrievedDoc> docs = new ArrayList<>(docsIn);
        docs.sort(Comparator.comparingInt(doc -> SOURCE_ORDER.indexOf(doc.source())));

        List<SourceRef> sources = new ArrayList<>();
        List<String> lines = new ArrayList<>();
        RetrievalSource lastSource = null;
        int charsUsed = 0;

        for (RetrievedDoc doc : docs) {
            String body = Tokenizer.clip(doc.text(), DOC_CLIP);
            // Budget already spent (but we always keep a minimum of three docs).
            if (sources.size() >= 3 && charsUsed + body.length() > CONTEXT_CHAR_BUDGET) {
                continue;
            }
            charsUsed += body.length() + 24;
            String id = "S" + (sources.size() + 1);
            Map<String, String> meta = doc.meta();
            String origin = meta != null && meta.get("origin") != null
                    ? meta.get("origin") : DEFAULT_ORIGIN.get(doc.source());
            String url = meta == null ? null : meta.get("url");
            sources.add(new SourceRef(id, doc.source(), Tokenizer.clip(doc.title(), 48), origin, url));
            if (doc.source() != lastSource) {
                lines.add("\n" + SOURCE_HEADING.get(doc.source()) + ":");
                lastSource = doc.source();
            }
            lines.add("[" + id + "] " + body);
        }

        boolean anyLiveDoc = docs.stream().anyMatch(d -> d.source() == RetrievalSource.LIVE);
        String missingLive = plan.includes(RetrievalSource.LIVE) && !anyLiveDoc
                ? "\nLive search returned nothing for this question — do not quote current prices, availability or opening hours; suggest the user run a live search."
                : "";

        String contextBlock;
        if (docs.isEmpty()) {
            // Planned retrieval, but nothing passed relevance — the model must
            // not fill the gap with invented specifics.
            String liveNote = plan.includes(RetrievalSource.LIVE)
                    ? " Live search also returned nothing, so current prices or availability must not be stated."
                    : "";
            contextBlock = "\n\n" + GROUNDING_RULES.replace("(ground this reply)", "— nothing relevant was found")
                    + "\nNo reliable context could be retrieved for this question. Do not state facts, prices, ratings or places you cannot verify from this conversation; say that you couldn't find reliable information."
                    + liveNote;
        } else {
            contextBlock = "\n\n" + GROUNDING_RULES + "\n" + String.join("\n", lines) + missingLive;
        }

        return new BuiltContext(contextBlock, sources);
    }

    /** User-visible footer inserted just before the machine-readable tags. */
    public static String buildSourcesFooter(List<SourceRef> sources) {
        if (sources.isEmpty()) {
            return "";
        }
        List<String> parts = new ArrayList<>();
        for (SourceRef source : sources) {
            parts.add(source.url() != null
                    ? "[" + source.id() + "] [" + source.label() + "](" + source.url() + ")"
                    : "[" + source.id() + "] " + source.label() + " \u00b7 " + source.origin());
        }
        return "\n\n---\n**Sources:** " + String.join(" \u00b7 ", parts);
    }
}
