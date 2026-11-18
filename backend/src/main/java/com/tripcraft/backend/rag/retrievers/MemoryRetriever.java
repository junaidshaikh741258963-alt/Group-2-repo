package com.tripcraft.backend.rag.retrievers;

import java.util.ArrayList;
import java.util.List;

import com.tripcraft.backend.rag.ChatTurn;
import com.tripcraft.backend.rag.RetrievalContext;
import com.tripcraft.backend.rag.RetrievedDoc;
import com.tripcraft.backend.rag.RetrievalSource;
import com.tripcraft.backend.rag.Tokenizer;

/**
 * Conversation/trip memory retriever — pure, no I/O. Port of
 * {@code src/lib/rag/retrievers/memory.ts}.
 *
 * <p>Selects only the turns that are actually relevant to a recollection-style
 * question. Every candidate must share content tokens with the question; the
 * single exception is a fallback to the most recent user answers when the
 * question is explicitly about a choice/pick ("What did I choose?"), because
 * the recent answers literally *are* the choices.
 */
public final class MemoryRetriever {

    private MemoryRetriever() {
    }

    private static final double MIN_SCORE = 0.1;

    private static final java.util.regex.Pattern CHOICE_RE = java.util.regex.Pattern.compile(
            "\\b(chose|choose|chosen|pick|picked|decided|decision|selected|selection|settled|went with|preferred)\\b",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    public static List<RetrievedDoc> retrieve(RetrievalContext ctx) {
        String question = ctx.question();
        List<ChatTurn> turns = ctx.turns();
        if (turns.isEmpty()) {
            return List.of();
        }

        List<RetrievedDoc> scored = new ArrayList<>();
        for (int i = 0; i < turns.size(); i++) {
            ChatTurn turn = turns.get(i);
            String text = Tokenizer.clip(turn.content(), 600);
            if (text.isEmpty()) {
                continue;
            }
            double score = Tokenizer.overlapScore(question, text);
            if (score < MIN_SCORE) {
                continue;
            }
            double recency = turns.size() <= 1 ? 1 : i / (double) (turns.size() - 1);
            RetrievedDoc doc = RetrievedDoc.of(
                    "memory-" + i,
                    RetrievalSource.MEMORY,
                    turn.isUser() ? "You said earlier in this conversation" : "Assistant said earlier",
                    text);
            doc.score(score * (0.75 + 0.25 * recency));
            doc.recency(recency);
            doc.putMeta("turn", String.valueOf(i + 1));
            scored.add(doc);
        }

        // Fallback for bare choice questions: the latest user answers are the picks.
        if (scored.size() < 2 && CHOICE_RE.matcher(question).find()) {
            List<int[]> recent = new ArrayList<>();
            for (int i = 0; i < turns.size(); i++) {
                if (turns.get(i).isUser()) {
                    recent.add(new int[]{i});
                }
            }
            if (recent.size() > 2) {
                recent = new ArrayList<>(recent.subList(recent.size() - 2, recent.size()));
            }
            for (int[] holder : recent) {
                int i = holder[0];
                boolean already = scored.stream().anyMatch(d -> ("memory-" + i).equals(d.id()));
                if (already) {
                    continue;
                }
                String text = Tokenizer.clip(turns.get(i).content(), 600);
                if (text.isEmpty()) {
                    continue;
                }
                RetrievedDoc doc = RetrievedDoc.of("memory-" + i, RetrievalSource.MEMORY,
                        "Your most recent answer", text);
                doc.score(0.5);
                doc.recency(turns.size() <= 1 ? 1 : i / (double) (turns.size() - 1));
                doc.putMeta("turn", String.valueOf(i + 1));
                scored.add(doc);
            }
        }

        scored.sort((a, b) -> Double.compare(b.score() == null ? 0 : b.score(),
                a.score() == null ? 0 : a.score()));
        return scored.size() > 6 ? new ArrayList<>(scored.subList(0, 6)) : scored;
    }

    /** Sanity helper used by /api/rag diagnostics. */
    public static List<String> memoryQueryTokens(String question) {
        return Tokenizer.queryTokens(question);
    }
}
