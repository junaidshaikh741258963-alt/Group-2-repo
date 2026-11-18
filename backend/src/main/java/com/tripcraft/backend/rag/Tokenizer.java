package com.tripcraft.backend.rag;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Light-weight text normalization for retrieval — the port of
 * {@code src/lib/rag/tokenize.ts}.
 *
 * <p>Deterministic and dependency-free: stopwords, a crude plural stem, and a
 * small synonym table so "chose / picked / selected" all match "choose".
 *
 * <p>Every expression here is the literal translation of the TypeScript one —
 * BM25 and the vector index both depend on this producing identical tokens.
 */
public final class Tokenizer {

    private Tokenizer() {
    }

    /**
     * JS {@code new Set(...split(" "))} silently de-duplicates — {@code Set.of}
     * would throw on the three repeated words the original list contains
     * ("does", "most", "some"), so build it duplicate-tolerant.
     */
    private static final Set<String> STOP = new java.util.LinkedHashSet<>(java.util.Arrays.asList(
            ("a an and are as at be been but by can could did do does for from had has have he her his i "
                    + "if in into is it its me my no not of on or our out over she so than that the their them then "
                    + "there these they this to too up us very was we were what when where which who why will with "
                    + "would you your about after again also any because before being between both during each few "
                    + "more most other some such through under until while am does don how just most only own same "
                    + "should some now tell please give shows show got get gets go going gonna hey ok okay yeah hi "
                    + "much many one two like im i'm i've i'd it's thats that's there's here's let's").split(" ")));

    /** Question words that carry no retrieval signal on their own. */
    private static final Set<String> QUESTION_WORDS = Set.of(
            "what", "whats", "what's", "who", "whom", "which", "where", "when", "why", "how",
            "is", "are", "was", "were", "do", "does", "did", "can", "could", "would", "should",
            "the", "a", "an", "of", "for", "to", "in", "on", "at", "and", "or", "my", "me", "i");

    /** Map surface forms → one canonical token so related phrasings collide. */
    private static final String[][] SYN_ROWS = {
            {"hotels", "hotel"}, {"hotel", "hotel"}, {"stays", "stay"}, {"stay", "stay"}, {"lodging", "hotel"},
            {"hostels", "hostel"}, {"resorts", "resort"}, {"accommodations", "accommodation"},
            {"restaurants", "restaurant"}, {"eateries", "restaurant"}, {"cafes", "cafe"}, {"cafés", "cafe"},
            {"foods", "food"}, {"cuisines", "cuisine"}, {"dishes", "dish"},
            {"prices", "price"}, {"pricing", "price"}, {"costs", "cost"}, {"fare", "price"}, {"fares", "price"},
            {"expenses", "cost"}, {"budgeting", "budget"}, {"budgets", "budget"},
            {"attractions", "attraction"}, {"sights", "sight"}, {"sightseeings", "sightseeing"},
            {"places", "place"}, {"spots", "spot"}, {"locations", "location"}, {"destinations", "destination"},
            {"cities", "city"}, {"countries", "country"}, {"trips", "trip"}, {"travels", "travel"},
            {"chosen", "choose"}, {"chose", "choose"}, {"picks", "choose"}, {"pick", "choose"}, {"picking", "choose"},
            {"choosing", "choose"}, {"selected", "choose"}, {"selecting", "choose"}, {"selection", "choose"},
            {"decided", "decide"}, {"decision", "decide"}, {"decisions", "decide"},
            {"prefer", "prefer"}, {"prefers", "prefer"}, {"preferred", "prefer"}, {"preference", "prefer"},
            {"preferences", "prefer"}, {"liking", "like"}, {"liked", "like"}, {"loves", "love"}, {"loved", "love"},
            {"plan", "plan"}, {"plans", "plan"}, {"planning", "plan"}, {"planned", "plan"},
            {"histories", "history"}, {"historical", "history"}, {"historic", "history"},
            {"cultures", "culture"}, {"cultural", "culture"}, {"customs", "custom"}, {"traditions", "tradition"},
            {"traditional", "tradition"}, {"etiquettes", "etiquette"},
            {"weathers", "weather"}, {"forecast", "weather"}, {"forecasts", "weather"},
            {"tickets", "ticket"}, {"visas", "visa"}, {"passports", "passport"},
            {"peoples", "people"}, {"person", "people"}, {"persons", "people"}, {"travelers", "people"},
            {"travellers", "people"}, {"adult", "adult"}, {"adults", "adult"}, {"kids", "kid"}, {"children", "child"},
            {"days", "day"}, {"nights", "night"}, {"weeks", "week"}, {"months", "month"}, {"years", "year"},
            {"museums", "museum"}, {"temples", "temple"}, {"shrines", "shrine"}, {"beaches", "beach"},
            {"mountains", "mountain"}, {"islands", "island"}, {"markets", "market"}, {"parks", "park"},
            {"neighborhoods", "neighbourhood"}, {"areas", "area"},
            {"buses", "bus"}, {"trains", "train"}, {"metros", "metro"}, {"subways", "subway"}, {"trams", "tram"},
            {"flights", "flight"}, {"planes", "plane"}, {"airports", "airport"},
            {"book", "book"}, {"booking", "book"}, {"reserve", "book"}, {"reservation", "book"},
            {"cheapest", "cheap"}, {"cheaper", "cheap"}, {"expensive", "cheapness"},
            {"near", "near"}, {"nearby", "near"}, {"around", "near"}, {"close", "near"},
            {"best", "good"}, {"top", "good"}, {"great", "good"}, {"nice", "good"},
            {"info", "information"}, {"infoabout", "information"}, {"details", "detail"},
            {"based", "base"}, {"itinerary", "itinerary"}, {"itineraries", "itinerary"},
    };

    private static final java.util.Map<String, String> SYN;

    static {
        java.util.Map<String, String> syn = new java.util.LinkedHashMap<>();
        for (String[] row : SYN_ROWS) {
            syn.put(row[0], row[1]);
        }
        SYN = java.util.Collections.unmodifiableMap(syn);
    }

    private static final Pattern DOUBLE_END = Pattern.compile("(.)\\1$");
    private static final Pattern COMBINING = Pattern.compile("[\u0300-\u036f]");
    private static final Pattern NON_TOKEN_CHARS = Pattern.compile("[^a-z0-9\u20b9$\u20ac\u00a3#]+");
    private static final Pattern SENTENCE_SPLIT = Pattern.compile("[.!?;:\n]\\s*");

    /** Generic capitals that are category words, not entities. */
    private static final Set<String> NON_ENTITY = Set.of(
            "hotel", "hotels", "hostel", "hostels", "restaurant", "restaurants",
            "museum", "museums", "park", "parks", "street", "streets", "tower",
            "palace", "castle", "city", "cities", "town", "trip", "day", "days",
            "thanks", "thank", "nice", "good", "great", "cool", "okay", "perfect",
            "exact", "well", "love", "hi", "hello", "hey", "bye");

    static String stem(String token) {
        String syn = SYN.get(token);
        if (syn != null) {
            return syn;
        }
        if (token.length() >= 6 && token.endsWith("ing")) {
            String cut = token.substring(0, token.length() - 3);
            return cut.length() > 3 && DOUBLE_END.matcher(cut).find()
                    ? cut.substring(0, cut.length() - 1) : cut;
        }
        if (token.length() >= 5 && token.endsWith("ed")) {
            String cut = token.substring(0, token.length() - 2);
            return cut.length() > 3 && DOUBLE_END.matcher(cut).find()
                    ? cut.substring(0, cut.length() - 1) : cut;
        }
        if (token.length() > 4 && token.endsWith("ies")) {
            return token.substring(0, token.length() - 3) + "y";
        }
        if (token.length() > 4 && token.endsWith("es") && !token.endsWith("ses")) {
            return token.substring(0, token.length() - 2);
        }
        if (token.length() > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
            return token.substring(0, token.length() - 1);
        }
        return token;
    }

    /** Split → lowercase → strip punctuation/diacritics → stem. Keeps order. */
    public static List<String> tokenize(String text) {
        String lower = text == null ? "" : text.toLowerCase(java.util.Locale.ROOT);
        String normalized = Normalizer.normalize(lower, Normalizer.Form.NFKD);
        normalized = COMBINING.matcher(normalized).replaceAll("");
        normalized = NON_TOKEN_CHARS.matcher(normalized).replaceAll(" ");
        String[] parts = normalized.split(" ");
        List<String> out = new ArrayList<>(parts.length);
        for (String part : parts) {
            if (!part.isEmpty()) {
                out.add(stem(part));
            }
        }
        return out;
    }

    /** Tokens that actually carry meaning for matching. */
    public static List<String> significantTokens(String text) {
        List<String> out = new ArrayList<>();
        for (String token : tokenize(text)) {
            if (token.length() > 1 && !STOP.contains(token)) {
                out.add(token);
            }
        }
        return out;
    }

    /** Question-only tokens ("what", "did", "i"…) — excluded from relevance math. */
    public static List<String> queryTokens(String text) {
        List<String> out = new ArrayList<>();
        for (String token : significantTokens(text)) {
            if (!QUESTION_WORDS.contains(token)) {
                out.add(token);
            }
        }
        return out;
    }

    /**
     * Crude proper-noun entities from a question: capitalised words that are
     * NOT sentence-initial. Used by the knowledge gate/fallback so a "visa for
     * Japan" question is not grounded on an India entry.
     */
    public static List<String> entityTokens(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) {
            return out;
        }
        // Split into sentences so only mid-sentence capitals count as entities.
        for (String sentence : text.split("[.!?;:\n]\\s*")) {
            if (sentence.isEmpty()) {
                continue;
            }
            // words = sentence.split(/\s+/).filter(Boolean)
            List<String> words = new ArrayList<>();
            for (String word : sentence.split("\\s+")) {
                if (!word.isEmpty()) {
                    words.add(word);
                }
            }
            for (int i = 1; i < words.size(); i++) {
                String word = words.get(i);
                String bare = Normalizer.normalize(word, Normalizer.Form.NFKD);
                bare = COMBINING.matcher(bare).replaceAll("");
                bare = bare.replaceAll("[^A-Za-z0-9]", "");
                char first = word.charAt(0);
                boolean capitalized = first >= 'A' && first <= 'Z';
                if (bare.length() < 2 || !capitalized) {
                    continue;
                }
                String key = bare.toLowerCase(java.util.Locale.ROOT);
                if (key.isEmpty() || STOP.contains(key) || QUESTION_WORDS.contains(key)
                        || NON_ENTITY.contains(key)) {
                    continue;
                }
                if (!out.contains(key)) {
                    out.add(key);
                }
            }
        }
        return out;
    }

    /** Unique tokens preserving first-seen order. */
    public static <T> List<T> unique(List<T> items) {
        Set<T> seen = new LinkedHashSet<>();
        for (T item : items) {
            if (seen.contains(item)) {
                continue;
            }
            seen.add(item);
        }
        return new ArrayList<>(seen);
    }

    /** Jaccard overlap of two token lists (0..1) — near-duplicate detection. */
    public static double jaccard(List<String> a, List<String> b) {
        if (a.isEmpty() || b.isEmpty()) {
            return 0;
        }
        Set<String> setA = new LinkedHashSet<>(a);
        Set<String> setB = new LinkedHashSet<>(b);
        int inter = 0;
        for (String token : setA) {
            if (setB.contains(token)) {
                inter++;
            }
        }
        int union = setA.size() + setB.size() - inter;
        return union == 0 ? 0 : inter / (double) union;
    }

    /**
     * Reference document length used to damp the precision term. Real
     * documents are hundreds of tokens long; using their raw size would make
     * the F1 score collapse to ~0 for every genuinely relevant hit.
     */
    private static final int REF_DOC_TOKENS = 24;

    /**
     * Token-overlap relevance (0..1) between a query and a document —
     * harmonic mean of query recall and a length-damped precision, plus a
     * phrase bonus for a verbatim query match.
     */
    public static double overlapScore(String query, String doc) {
        List<String> q = queryTokens(query);
        Set<String> d = new LinkedHashSet<>(significantTokens(doc));
        if (q.isEmpty() || d.isEmpty()) {
            return 0;
        }
        int hits = 0;
        for (String token : q) {
            if (d.contains(token)) {
                hits++;
            }
        }
        double recall = hits / (double) q.size();
        // Capped at `hits` so precision can never exceed 1 when the query is
        // longer than the reference length.
        double precision = hits / (double) Math.max(hits, Math.min(d.size(), REF_DOC_TOKENS));
        double f = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
        // Phrase bonus: the whole query (minus punctuation) appearing verbatim.
        String needle = query.toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[^a-z0-9 ]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        double phrase = q.size() > 1 && needle.length() > 8
                && doc.toLowerCase(java.util.Locale.ROOT).contains(needle) ? 0.15 : 0;
        return Math.min(1, f * 0.85 + phrase);
    }

    /** Truncate on a word boundary for context building. */
    public static String clip(String text, int max) {
        String clean = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        if (clean.length() <= max) {
            return clean;
        }
        String cut = clean.substring(0, max);
        int lastSpace = cut.lastIndexOf(' ');
        return cut.substring(0, lastSpace > max * 0.6 ? lastSpace : max) + "\u2026";
    }
}
