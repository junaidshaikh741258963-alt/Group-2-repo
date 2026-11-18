package com.tripcraft.backend.rag;

/**
 * One prior conversation turn, oldest → newest (meta blocks already stripped).
 * Mirrors {@code ChatTurn} in {@code src/lib/rag/types.ts}.
 *
 * @param role    {@code "user"} or {@code "assistant"}
 * @param content turn text
 */
public record ChatTurn(String role, String content) {

    public boolean isUser() {
        return "user".equals(role);
    }
}
