package com.tripcraft.backend.rag.retrievers;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.tripcraft.backend.rag.RetrievalContext;
import com.tripcraft.backend.rag.RetrievedDoc;
import com.tripcraft.backend.rag.RetrievalSource;
import com.tripcraft.backend.rag.Tokenizer;
import com.tripcraft.backend.rag.TripItemLite;

/**
 * User-specific preference retriever — pure, no I/O. Port of
 * {@code src/lib/rag/retrievers/preferences.ts}.
 *
 * <p>Two ingredients: explicit preference sentences mined from the
 * conversation, and saved trip-board items (the things the user actually
 * picked). The trip <em>profile</em> itself is NOT repeated here — the chat
 * route already puts it in every prompt.
 */
public final class PreferencesRetriever {

    private PreferencesRetriever() {
    }

    /**
     * Preference statements, mined from a sentence boundary (start, end-of-
     * sentence punctuation, newline, or a comma clause). Must handle the
     * contracted forms people actually type.
     */
    private static final Pattern PREF_LINE_RE = Pattern.compile(
            "(?:^|[.!?\\n]|,\\s)\\s*((?:i|we)(?:['\u2019]m|\\s+am|\\s+re)?\\s+"
                    + "(?:prefer|like|love|always|never|only|want|need|hate|avoid|dislike|vegetarian|vegan|"
                    + "allergic to|don['\u2019]?t eat|dont eat|won['\u2019]?t)\\b[^.!?\\n]{0,130})",
            Pattern.CASE_INSENSITIVE);

    private static final int MAX_PREF_LINES = 4;
    private static final int MAX_BOARD_ITEMS = 5;

    private static List<String> minePreferenceLines(RetrievalContext ctx) {
        List<String> found = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (var turn : ctx.turns()) {
            Matcher matcher = PREF_LINE_RE.matcher(turn.content());
            while (matcher.find()) {
                String line = Tokenizer.clip(matcher.group(1), 150);
                String key = line.toLowerCase(java.util.Locale.ROOT);
                if (line.isEmpty() || seen.contains(key)) {
                    continue;
                }
                seen.add(key);
                found.add(line);
                if (found.size() >= MAX_PREF_LINES) {
                    return found;
                }
            }
        }
        return found;
    }

    private static String itemText(TripItemLite item) {
        List<String> parts = new ArrayList<>();
        addIfPresent(parts, item.name());
        addIfPresent(parts, item.category());
        addIfPresent(parts, item.detail());
        addIfPresent(parts, item.description());
        if (item.price() != null && !item.price().isEmpty()) {
            parts.add("price " + item.price());
        }
        if (item.rating() != null && item.rating() != 0) {
            parts.add("rated " + formatRating(item.rating()) + " of 5");
        }
        return String.join(" \u00b7 ", parts);
    }

    private static void addIfPresent(List<String> parts, String value) {
        if (value != null && !value.isEmpty()) {
            parts.add(value);
        }
    }

    /** TS {@code item.rating} printed as-is (a JSON number, no forced decimals). */
    private static String formatRating(double rating) {
        if (rating == Math.rint(rating) && !Double.isInfinite(rating)) {
            return String.valueOf((long) rating);
        }
        return String.valueOf(rating);
    }

    public static List<RetrievedDoc> retrieve(RetrievalContext ctx) {
        List<RetrievedDoc> docs = new ArrayList<>();
        List<String> qTokens = Tokenizer.queryTokens(ctx.question());

        for (String line : minePreferenceLines(ctx)) {
            RetrievedDoc doc = RetrievedDoc.of("preferences-" + docs.size(),
                    RetrievalSource.PREFERENCES, "Your stated preference", line);
            doc.score(0.55 + 0.45 * Tokenizer.overlapScore(ctx.question(), line));
            doc.recency(1.0);
            doc.putMeta("origin", "from this conversation");
            docs.add(doc);
        }

        record ScoredItem(TripItemLite item, String text, int i, double overlap, boolean matchesTokens) {
        }
        List<ScoredItem> items = new ArrayList<>();
        for (int i = 0; i < ctx.tripItems().size(); i++) {
            TripItemLite item = ctx.tripItems().get(i);
            String text = itemText(item);
            double overlap = Tokenizer.overlapScore(ctx.question(), text);
            boolean matchesTokens = false;
            if (qTokens.size() > 0) {
                List<String> textTokens = Tokenizer.queryTokens(text);
                for (String token : textTokens) {
                    if (qTokens.contains(token)) {
                        matchesTokens = true;
                        break;
                    }
                }
            }
            items.add(new ScoredItem(item, text, i, overlap, matchesTokens));
        }

        // Prefer items that match the question (or its destination); fall back
        // to the most recently saved ones so a recall question still has an answer.
        List<ScoredItem> matched = new ArrayList<>();
        for (ScoredItem item : items) {
            if (item.overlap() > 0 || item.matchesTokens()) {
                matched.add(item);
            }
        }
        List<ScoredItem> chosen;
        if (!matched.isEmpty()) {
            chosen = matched;
        } else {
            chosen = new ArrayList<>(items);
            chosen.sort(Comparator.comparingInt(ScoredItem::i).reversed());
            if (chosen.size() > 3) {
                chosen = new ArrayList<>(chosen.subList(0, 3));
            }
        }
        List<ScoredItem> ordered = new ArrayList<>(chosen);
        ordered.sort(Comparator.comparingDouble(ScoredItem::overlap).reversed());
        if (ordered.size() > MAX_BOARD_ITEMS) {
            ordered = new ArrayList<>(ordered.subList(0, MAX_BOARD_ITEMS));
        }

        for (ScoredItem x : ordered) {
            RetrievedDoc doc = RetrievedDoc.of("preferences-item-" + x.i(),
                    RetrievalSource.PREFERENCES,
                    "On your trip board: " + x.item().name(),
                    Tokenizer.clip(x.text(), 320));
            doc.score(0.35 + 0.5 * x.overlap());
            doc.recency(1.0);
            doc.putMeta("category", x.item().category() == null ? "other" : x.item().category());
            doc.putMeta("origin", "saved to your trip");
            docs.add(doc);
        }

        docs.sort((a, b) -> Double.compare(b.score() == null ? 0 : b.score(),
                a.score() == null ? 0 : a.score()));
        return docs.size() > 8 ? new ArrayList<>(docs.subList(0, 8)) : docs;
    }
}
