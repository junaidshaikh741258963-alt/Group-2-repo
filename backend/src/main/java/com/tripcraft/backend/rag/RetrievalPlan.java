package com.tripcraft.backend.rag;

import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * What to fetch for this question — decided by the router BEFORE retrieval.
 * Mirrors {@code RetrievalPlan} in {@code src/lib/rag/types.ts}; every optional
 * field is {@code null} exactly where TypeScript would leave the key
 * {@code undefined} (and therefore absent from the JSON).
 */
public final class RetrievalPlan {

    /** What kind of live fact is needed. */
    public enum LiveKind {
        HOTEL("hotel"), FOOD("food"), SIGHT("sight"), WEATHER("weather");

        private final String wire;

        LiveKind(String wire) {
            this.wire = wire;
        }

        public String wire() {
            return wire;
        }

        public static LiveKind fromWire(String value) {
            for (LiveKind kind : values()) {
                if (kind.wire.equals(value)) {
                    return kind;
                }
            }
            return null;
        }
    }

    /** Budget cap parsed from the question, used to filter live results. */
    public record Budget(double amount, String currency) {
    }

    /** TS {@code EMPTY_PLAN} — reason {@code "no retrieval needed"}. */
    public static final RetrievalPlan EMPTY =
            new RetrievalPlan(List.of(), null, null, null, null, "no retrieval needed");

    private final List<RetrievalSource> sources;
    private final String place;
    private final LiveKind liveKind;
    private final Budget budget;
    private final String knowledgeQuery;
    private final String reason;

    public RetrievalPlan(List<RetrievalSource> sources, String place, LiveKind liveKind,
                         Budget budget, String knowledgeQuery, String reason) {
        this.sources = sources == null ? List.of() : List.copyOf(sources);
        this.place = place;
        this.liveKind = liveKind;
        this.budget = budget;
        this.knowledgeQuery = knowledgeQuery;
        this.reason = reason;
    }

    public List<RetrievalSource> sources() {
        return sources;
    }

    public String place() {
        return place;
    }

    public LiveKind liveKind() {
        return liveKind;
    }

    public Budget budget() {
        return budget;
    }

    public String knowledgeQuery() {
        return knowledgeQuery;
    }

    public String reason() {
        return reason;
    }

    /** TS {@code {...plan, sources: filtered}} — every other field is carried over. */
    public RetrievalPlan withSources(List<RetrievalSource> filtered) {
        return new RetrievalPlan(filtered, place, liveKind, budget, knowledgeQuery, reason);
    }

    public boolean includes(RetrievalSource source) {
        return sources.contains(source);
    }

    /**
     * Serialises the plan: {@code sources} and {@code reason} are always
     * present, the optional keys only when set (TS emits them only when
     * assigned).
     */
    public ObjectNode toJson() {
        ObjectNode node = Json.obj();
        ArrayNode sourcesNode = node.putArray("sources");
        for (RetrievalSource source : sources) {
            sourcesNode.add(source.wire());
        }
        node.put("reason", reason == null ? "" : reason);
        if (place != null) {
            node.put("place", place);
        }
        if (liveKind != null) {
            node.put("liveKind", liveKind.wire());
        }
        if (budget != null) {
            ObjectNode budgetNode = node.putObject("budget");
            Wire.putWhole(budgetNode, "amount", budget.amount());
            budgetNode.put("currency", budget.currency());
        }
        if (knowledgeQuery != null) {
            node.put("knowledgeQuery", knowledgeQuery);
        }
        return node;
    }

    /** Diagnostics helper — the plan fields as a mutable list for logging/tests. */
    public List<String> sourceWires() {
        List<String> out = new ArrayList<>();
        for (RetrievalSource source : sources) {
            out.add(source.wire());
        }
        return out;
    }
}
