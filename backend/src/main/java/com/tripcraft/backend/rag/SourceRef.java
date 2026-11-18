package com.tripcraft.backend.rag;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * A source line for the "Sources" footer — {@code SourceRef} in
 * {@code src/lib/rag/types.ts}.
 *
 * @param id     stable id inside one run ({@code S1}, {@code S2}, …)
 * @param source where it came from
 * @param label  short human label (clipped title)
 * @param origin provider / location line for the footer
 * @param url    optional link — omitted from the wire when null
 */
public record SourceRef(String id, RetrievalSource source, String label, String origin, String url) {

    public ObjectNode toJson() {
        ObjectNode node = Json.obj();
        node.put("id", id);
        node.put("source", source.wire());
        node.put("label", label);
        node.put("origin", origin);
        if (url != null) {
            node.put("url", url);
        }
        return node;
    }
}
