package com.tripcraft.backend.rag;

import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * One retrieved document — {@code RetrievedDoc} in {@code src/lib/rag/types.ts}.
 *
 * <p>Nullable doubles are TypeScript's optional {@code number} fields: {@code
 * null} means the key was never set and is omitted from the wire.
 */
public final class RetrievedDoc {

    private String id;
    private RetrievalSource source;
    private String title;
    private String text;
    /** Ranking metadata filled in by the retriever / reranker. */
    private Double score;
    /** Question↔doc lexical overlap (diagnostics + the knowledge/web gate). */
    private Double lexical;
    /** 0..1 — how recent the doc is. */
    private Double recency;
    /** Provenance for citations: url, provider, checked-at note, category… */
    private Map<String, String> meta;

    public RetrievedDoc() {
    }

    /** Copies every field — TS {@code {...doc}}. */
    public RetrievedDoc(RetrievedDoc other) {
        this.id = other.id;
        this.source = other.source;
        this.title = other.title;
        this.text = other.text;
        this.score = other.score;
        this.lexical = other.lexical;
        this.recency = other.recency;
        this.meta = other.meta == null ? null : new LinkedHashMap<>(other.meta);
    }

    public static RetrievedDoc of(String id, RetrievalSource source, String title, String text) {
        RetrievedDoc doc = new RetrievedDoc();
        doc.id = id;
        doc.source = source;
        doc.title = title;
        doc.text = text;
        return doc;
    }

    public String id() {
        return id;
    }

    public void id(String id) {
        this.id = id;
    }

    public RetrievalSource source() {
        return source;
    }

    public void source(RetrievalSource source) {
        this.source = source;
    }

    public String title() {
        return title;
    }

    public void title(String title) {
        this.title = title;
    }

    public String text() {
        return text;
    }

    public void text(String text) {
        this.text = text;
    }

    public Double score() {
        return score;
    }

    public void score(Double score) {
        this.score = score;
    }

    public Double lexical() {
        return lexical;
    }

    public void lexical(Double lexical) {
        this.lexical = lexical;
    }

    public Double recency() {
        return recency;
    }

    public void recency(Double recency) {
        this.recency = recency;
    }

    public Map<String, String> meta() {
        return meta;
    }

    public void meta(Map<String, String> meta) {
        this.meta = meta;
    }

    public RetrievedDoc putMeta(String key, String value) {
        if (meta == null) {
            meta = new LinkedHashMap<>();
        }
        meta.put(key, value);
        return this;
    }

    /** The {@code docs[]} entry emitted by {@code POST /api/rag}. */
    public ObjectNode toJson() {
        ObjectNode node = Json.obj();
        node.put("id", id == null ? "" : id);
        node.put("source", source == null ? "" : source.wire());
        node.put("title", title == null ? "" : title);
        node.put("text", text == null ? "" : text);
        Wire.putRound3(node, "score", score == null ? 0 : score);
        Wire.putRound3(node, "lexical", lexical == null ? 0 : lexical);
        if (meta != null) {
            ObjectNode metaNode = node.putObject("meta");
            meta.forEach(metaNode::put);
        }
        return node;
    }
}
