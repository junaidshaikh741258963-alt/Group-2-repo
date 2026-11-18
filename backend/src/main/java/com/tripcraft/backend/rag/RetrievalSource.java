package com.tripcraft.backend.rag;

/**
 * Where a retrieved document came from — the wire union of
 * {@code src/lib/rag/types.ts}: {@code "memory" | "preferences" | "knowledge"
 * | "live" | "web"}.
 */
public enum RetrievalSource {
    MEMORY("memory"),
    PREFERENCES("preferences"),
    KNOWLEDGE("knowledge"),
    LIVE("live"),
    WEB("web");

    private final String wire;

    RetrievalSource(String wire) {
        this.wire = wire;
    }

    /** Exact string that appears on the wire. */
    public String wire() {
        return wire;
    }

    public static RetrievalSource fromWire(String value) {
        for (RetrievalSource s : values()) {
            if (s.wire.equals(value)) {
                return s;
            }
        }
        return null;
    }
}
