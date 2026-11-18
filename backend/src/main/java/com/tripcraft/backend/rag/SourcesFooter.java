package com.tripcraft.backend.rag;

import java.util.List;

/**
 * Stream transform: appends a "Sources: [S1] …" footer to the model's reply,
 * placed immediately BEFORE the first {@code <recommendations>} /
 * {@code <planning>} tag (the client strips everything from those tags onward,
 * so the footer would otherwise be invisible) — the port of
 * {@code src/lib/rag/sourcesFooter.ts}.
 *
 * <p>Streaming stays live: only a small tail is held back so a tag starting at
 * the boundary can still be detected. Feed UTF-8 decoded chunks to
 * {@link #push(String)} and call {@link #finish()} when the source ends.
 */
public final class SourcesFooter {

    private static final List<String> TAG_MARKERS = List.of("<recommendations>", "<planning>");

    /** Must exceed the longest tag marker by a wide margin. */
    private static final int TAIL_HOLD = 400;

    private final String footer;
    private String tail = "";
    private boolean inserted;

    public SourcesFooter(String footer) {
        this.footer = footer == null ? "" : footer;
    }

    private static int firstTagIndex(String text) {
        int best = -1;
        for (String marker : TAG_MARKERS) {
            int idx = text.indexOf(marker);
            if (idx != -1 && (best == -1 || idx < best)) {
                best = idx;
            }
        }
        return best;
    }

    /**
     * Feed the next decoded chunk; returns the text that may be emitted now
     * (possibly {@code ""}).
     */
    public String push(String chunk) {
        String text = tail + (chunk == null ? "" : chunk);
        tail = "";

        if (inserted || footer.isEmpty()) {
            return text;
        }

        int idx = firstTagIndex(text);
        if (idx != -1) {
            inserted = true;
            return text.substring(0, idx) + footer + text.substring(idx);
        }

        if (text.length() > TAIL_HOLD) {
            int emit = text.length() - TAIL_HOLD;
            tail = text.substring(emit);
            return text.substring(0, emit);
        }
        tail = text;
        return "";
    }

    /**
     * End of stream: flushes the held tail, inserting the footer before the
     * first machine-readable tag (or appending it at the very end).
     */
    public String finish() {
        String rest = tail;
        tail = "";
        if (inserted || footer.isEmpty()) {
            return rest;
        }
        inserted = true;
        int idx = firstTagIndex(rest);
        if (idx != -1) {
            return rest.substring(0, idx) + footer + rest.substring(idx);
        }
        return rest + footer;
    }

    /** Whole-text convenience — one push + finish, exactly like a single chunk. */
    public static String apply(String source, String footer) {
        SourcesFooter transform = new SourcesFooter(footer);
        return transform.push(source) + transform.finish();
    }
}
