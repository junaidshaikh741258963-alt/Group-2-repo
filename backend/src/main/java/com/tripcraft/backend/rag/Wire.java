package com.tripcraft.backend.rag;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Wire helpers shared by the RAG response builders.
 *
 * <p>Numbers that TypeScript produced with {@code Number(x.toFixed(3))} must
 * keep that exact shape: {@code 1} (integral, no {@code .0}) and at most three
 * decimals otherwise.
 */
final class Wire {

    private Wire() {
    }

    /** Puts {@code round(value, 3)} like TS {@code Number(value.toFixed(3))}. */
    static void putRound3(ObjectNode node, String field, double value) {
        double rounded = Math.round(value * 1000.0) / 1000.0;
        if (rounded == Math.rint(rounded) && !Double.isInfinite(rounded)) {
            node.put(field, (long) rounded);
        } else {
            node.put(field, rounded);
        }
    }

    /** Puts a whole number without a {@code .0} suffix ({@code 10000}, not {@code 10000.0}). */
    static void putWhole(ObjectNode node, String field, double value) {
        if (value == Math.rint(value) && !Double.isInfinite(value)) {
            node.put(field, (long) value);
        } else {
            node.put(field, value);
        }
    }
}
