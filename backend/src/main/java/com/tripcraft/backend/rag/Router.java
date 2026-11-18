package com.tripcraft.backend.rag;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Intent routing: decide WHICH retrieval sources (if any) serve this question —
 * the port of {@code src/lib/rag/router.ts}.
 *
 * <p>The chat's stage-machine flow ("Tokyo", "2 adults", "Budget") must run
 * with zero retrieval — those messages carry no question worth fetching for.
 * Pure function: question + context → retrieval plan. No I/O.
 */
public final class Router {

    private Router() {
    }

    /** Recollection: the user is asking about something from this conversation/trip. */
    private static final Pattern RECALL_RE = Pattern.compile(
            "\\b(what did i|which .{0,30} did i|did i|do i remember|do you remember|i chose|i picked|i picked|we picked|we chose|we decided|my (?:previous|earlier|last|own) (?:trip|choice|pick|selection|preferences?)|earlier|previously|previous(?:ly)?|remember|you (?:said|mentioned|recommended)|as (?:i|you) (?:said|mentioned)|the hotel i|the dates i|my pick|my choice|like i said|going back to|change my mind about|final(?:ly)? (?:chose|picked|decided))\\b",
            Pattern.CASE_INSENSITIVE);

    /** User-specific preference: retrieval from profile + mined preference lines. */
    private static final Pattern PREFERENCE_RE = Pattern.compile(
            "\\b(i (?:prefer|like|love|hate|dislike|avoid|want|need|always|never|only|am into|am a)|we (?:prefer|like|love|always|never|only|are)|based on my|my (?:preferences?|taste|style|budget|interests)|as per my|remember that i|vegetarian|vegan|no (?:alcohol|meat|spicy)|allergic)\\b",
            Pattern.CASE_INSENSITIVE);

    private record LiveKindRule(RetrievalPlan.LiveKind kind, Pattern re) {
    }

    private static final List<LiveKindRule> LIVE_KIND_RES = List.of(
            new LiveKindRule(RetrievalPlan.LiveKind.HOTEL, Pattern.compile(
                    "\\b(hotels?|hostels?|resorts?|accommodation|lodging|where to (?:stay|sleep)|places to stay|stays|guesthouses?|airbnb)\\b",
                    Pattern.CASE_INSENSITIVE)),
            new LiveKindRule(RetrievalPlan.LiveKind.FOOD, Pattern.compile(
                    "\\b(restaurants?|caf[e\u00e9]s?|dining|eat(?:ing)?|food|cuisine|street food|breakfast|brunch|lunch|dinner|ramen|noodles?|pizza|bagels?|baker(?:y|ies)|coffee|delis?|eateries|diners?|bars?)\\b",
                    Pattern.CASE_INSENSITIVE)),
            new LiveKindRule(RetrievalPlan.LiveKind.WEATHER, Pattern.compile(
                    "\\b(weather|forecast|rain(?:ing)?|temperature|how (?:hot|cold|warm)|sunny|snow(?:ing)?)\\b",
                    Pattern.CASE_INSENSITIVE)),
            new LiveKindRule(RetrievalPlan.LiveKind.SIGHT, Pattern.compile(
                    "\\b(attractions?|things to (?:do|see|visit|go)|places to (?:visit|see|go)|what to (?:see|do)|sights|sightseeing|activities|tours?|points? of interest|landmarks?|shops?|markets?|show me|explore)\\b",
                    Pattern.CASE_INSENSITIVE)));

    /** Needs *current* data regardless of category (prices, availability, timing). */
    private static final Pattern VOLATILE_RE = Pattern.compile(
            "\\b(under|below|less than|upto|up to|per night|tonight|tomorrow|today|this weekend|open now|available|availability|prices?|costs?|fare|how much)\\b",
            Pattern.CASE_INSENSITIVE);

    /** Encyclopedic / how-it-works questions → knowledge base (web fallback). */
    private static final Pattern KNOWLEDGE_RE = Pattern.compile(
            "\\b(history|historical|tell me about|facts? about|meaning|origin|founded|built|century|culture|cultural|customs?|traditions?|etiquette|visa|passport|entry requirement|best time|when should i (?:visit|go|travel)|climate|language|religion|tipping|\\btips?\\b|dress code|is .{0,40} safe|safety|how does .{0,40} work|why (?:is|do|does|are)|what (?:is|are|was|were) (?:the )?|what (?:do|does|did|can|should)|explain|define|who (?:was|built|founded)|difference between|schengen|jr pass|e-?visa|irctc|esim|sim card|jet lag|insurance|packing|vegetarian|vegan|solo travel|family travel|layover|connection|budget(?:ing)?|booking|etiquet)",
            Pattern.CASE_INSENSITIVE);

    /** The second half of the knowledge gate: interrogative / "about" phrasing. */
    private static final Pattern KNOWLEDGE_QUESTION_RE = Pattern.compile(
            "\\?|tell me|explain|describe|about|how (?:do|does|to)\\b",
            Pattern.CASE_INSENSITIVE);

    /** Multi-source synthesis ("plan … based on my previous preferences"). */
    private static final Pattern SYNTHESIS_RE = Pattern.compile(
            "\\b(plan|build|create|design|itinerary|day[- ]by[- ]day|schedule)\\b",
            Pattern.CASE_INSENSITIVE);

    private static final int MAX_SOURCES = 4;

    private static final List<RetrievalSource> PRIORITY = List.of(
            RetrievalSource.MEMORY, RetrievalSource.PREFERENCES,
            RetrievalSource.LIVE, RetrievalSource.KNOWLEDGE);

    /** Explicit search intent — needed when the place isn't named in the question. */
    private static final Pattern SEARCHISH_RE = Pattern.compile(
            "\\b(show me|find|search|recommend|suggest|give me|list|looking for|need|want|where can|any good|good|nice|best|top)\\b",
            Pattern.CASE_INSENSITIVE);

    private record CurrencyRule(Pattern re, String code) {
    }

    private static final List<CurrencyRule> CURRENCY_PATTERNS = List.of(
            new CurrencyRule(Pattern.compile("(?:\u20b9|inr|rs\\.|rupees?)", Pattern.CASE_INSENSITIVE), "INR"),
            new CurrencyRule(Pattern.compile("(?:\\$|usd|dollars?)", Pattern.CASE_INSENSITIVE), "USD"),
            new CurrencyRule(Pattern.compile("(?:\u20ac|eur|euros?)", Pattern.CASE_INSENSITIVE), "EUR"),
            new CurrencyRule(Pattern.compile("(?:\u00a3|gbp|pounds?)", Pattern.CASE_INSENSITIVE), "GBP"));

    private static final Pattern BUDGET_LEAD = Pattern.compile(
            "\\b(?:under|below|less than|upto|up to|max|within|around|about|budget(?:\\s+of)?)\\s+([^!?\\n]{0,28})",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern FIRST_NUMBER = Pattern.compile("(\\d[\\d,]*)");

    private static String currencyIn(String segment) {
        for (CurrencyRule rule : CURRENCY_PATTERNS) {
            if (rule.re().matcher(segment).find()) {
                return rule.code();
            }
        }
        return null;
    }

    /**
     * Parse "under ₹10,000" / "10000 rupees" / "below $200". A currency signal
     * is required — a bare number's units are ambiguous.
     */
    public static RetrievalPlan.Budget parseBudget(String question) {
        Matcher lead = BUDGET_LEAD.matcher(question);
        if (lead.find()) {
            String segment = lead.group(1);
            String currency = currencyIn(segment);
            Matcher num = FIRST_NUMBER.matcher(segment);
            if (currency != null && num.find()) {
                Double amount = parseAmount(num.group(1));
                if (amount != null && amount > 0) {
                    return new RetrievalPlan.Budget(amount, currency);
                }
            }
        }
        // Bare "₹10,000" / "$200" without a qualifier.
        for (CurrencyRule rule : CURRENCY_PATTERNS) {
            Matcher m = Pattern.compile(rule.re().pattern() + "\\s*([\\d,]+)",
                    Pattern.CASE_INSENSITIVE).matcher(question);
            if (m.find()) {
                Double amount = parseAmount(m.group(1));
                if (amount != null && amount > 0) {
                    return new RetrievalPlan.Budget(amount, rule.code());
                }
            }
        }
        return null;
    }

    /** TS {@code Number(num.replace(/,/g, ""))} with the {@code isFinite} guard. */
    private static Double parseAmount(String raw) {
        try {
            double value = Double.parseDouble(raw.replace(",", ""));
            return Double.isFinite(value) ? value : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static final Pattern CAPS_PLACE = Pattern.compile(
            "\\b(?:in|near|around|to|from|at)\\s+(?:the\\s+|this\\s+|that\\s+)?([A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+)*)");

    private static final Pattern LOWER_PLACE = Pattern.compile(
            "\\b(?:in|near|around|from|at)\\s+([a-z][a-z'-]{2,24})(?=[\\s,.!?]|$)");

    private static final Pattern TO_LOWER_PLACE = Pattern.compile(
            "\\bto\\s+([a-z][a-z'-]{2,24})(?=[\\s,.!?]|$)");

    private static final java.util.Set<String> NOT_A_PLACE = java.util.Set.of(
            "eat", "go", "see", "visit", "do", "stay", "sleep", "buy", "have", "make", "take",
            "spend", "plan", "book", "get", "fly", "drive", "walk", "swim", "check", "find",
            "want", "need", "like", "love", "try", "explore", "relax", "this", "that", "the",
            "some", "any", "good", "great", "nice", "best", "where", "what", "when", "how",
            "why", "my", "our", "your", "me", "you", "them", "us", "it");

    private static final java.util.Set<String> NON_PLACE_WORDS = java.util.Set.of(
            "the", "and", "for", "with", "you", "your", "about", "please", "tell", "what", "where",
            "when", "which", "how", "why", "give", "show", "find", "best", "top", "this", "that",
            "there", "here", "hotel", "hotels", "trip", "day", "days", "good", "nice", "want",
            "need", "like", "love", "plan", "build", "create", "make", "some", "any", "really",
            "very", "can", "could", "would", "should", "into", "over", "under", "next", "last",
            "it", "its", "he", "she", "we", "they", "his", "her", "our", "their", "am", "is",
            "are", "was", "were", "be", "being", "been", "do", "does", "did", "have", "has",
            "had", "not", "yes", "now", "then", "also", "just", "only", "even", "still");

    /** Strict: a place clearly referenced by the question ("hotels in Tokyo"). */
    public static String placeFromQuestion(RetrievalContext ctx) {
        String q = ctx.question().trim();
        // Capitalised run after a locator preposition → multi-word-safe, never
        // swallows trailing sentence words ("in Tokyo are under" → "Tokyo").
        Matcher caps = CAPS_PLACE.matcher(q);
        if (caps.find()) {
            return caps.group(1).trim();
        }
        // Single lowercase word ("hotels in tokyo") — one word only, and never
        // a verb ("want to eat" must not resolve to place "eat").
        Matcher lower = LOWER_PLACE.matcher(q);
        if (lower.find() && !NOT_A_PLACE.contains(lower.group(1))) {
            return lower.group(1);
        }
        Matcher toLower = TO_LOWER_PLACE.matcher(q);
        if (toLower.find() && !NOT_A_PLACE.contains(toLower.group(1))) {
            return toLower.group(1);
        }
        return null;
    }

    /** Loose: any capitalised proper-noun run anywhere in the question. */
    public static String loosePlaceFromQuestion(RetrievalContext ctx) {
        String[] words = ctx.question().trim().split("\\s+");
        List<String> runs = new ArrayList<>();
        StringBuilder run = new StringBuilder();
        for (String raw : words) {
            String w = raw.replaceAll("[^A-Za-z-]", "");
            boolean isProper = w.matches("[A-Z][a-zA-Z-]{2,}")
                    && !NON_PLACE_WORDS.contains(w.toLowerCase(java.util.Locale.ROOT));
            if (isProper) {
                if (run.length() > 0) {
                    run.append(' ');
                }
                run.append(w);
            } else if (run.length() > 0) {
                runs.add(run.toString());
                run.setLength(0);
            }
        }
        if (run.length() > 0) {
            runs.add(run.toString());
        }
        if (runs.isEmpty()) {
            return null;
        }
        // Longest run wins: "Tokyo Imperial Palace" over a stray single capital.
        runs.sort((a, b) -> b.length() - a.length());
        return runs.get(0);
    }

    /** Place for live lookup: strict question match → trip profile → loose match. */
    public static String resolvePlace(RetrievalContext ctx) {
        String strict = placeFromQuestion(ctx);
        if (strict != null) {
            return strict;
        }
        String dest = ctx.profile().destination();
        if (dest != null && !dest.trim().isEmpty()) {
            return dest.trim();
        }
        return loosePlaceFromQuestion(ctx);
    }

    private static RetrievalPlan.LiveKind detectLiveKind(String question) {
        for (LiveKindRule rule : LIVE_KIND_RES) {
            if (rule.re().matcher(question).find()) {
                return rule.kind();
            }
        }
        // price/availability on a named place
        return VOLATILE_RE.matcher(question).find() ? RetrievalPlan.LiveKind.SIGHT : null;
    }

    /** Pure function: question + context → retrieval plan. No I/O. */
    public static RetrievalPlan planRetrieval(RetrievalContext ctx) {
        String q = ctx.question().trim();
        if (q.isEmpty()) {
            return RetrievalPlan.EMPTY;
        }

        java.util.LinkedHashSet<RetrievalSource> signals = new java.util.LinkedHashSet<>();
        List<String> reasons = new ArrayList<>();

        boolean isRecall = RECALL_RE.matcher(q).find();
        if (isRecall) {
            signals.add(RetrievalSource.MEMORY);
            reasons.add("recall wording");
        }
        if (PREFERENCE_RE.matcher(q).find()) {
            signals.add(RetrievalSource.PREFERENCES);
            reasons.add("preference wording");
        }

        RetrievalPlan.LiveKind liveKind = detectLiveKind(q);
        String placeInQuestion = placeFromQuestion(ctx);
        String place = placeInQuestion != null ? placeInQuestion : resolvePlace(ctx);
        // Live data only when the question *asks* for it: it names the place
        // itself, or it is phrased as a search/interrogative/current-fact
        // question. A bare hotel name never triggers a live API call.
        boolean wantsData = q.indexOf('?') >= 0 || VOLATILE_RE.matcher(q).find()
                || SEARCHISH_RE.matcher(q).find();
        boolean wantsLiveData = liveKind != null && place != null
                && (placeInQuestion != null || wantsData);
        if (liveKind != null && wantsLiveData) {
            signals.add(RetrievalSource.LIVE);
            reasons.add("live(" + liveKind.wire() + ")");
        }

        // A recollection question is about THIS conversation — KB entries that
        // share its wording are noise, so knowledge only joins when the
        // question is genuinely encyclopedic AND not a recall.
        if (!isRecall && KNOWLEDGE_RE.matcher(q).find() && KNOWLEDGE_QUESTION_RE.matcher(q).find()) {
            signals.add(RetrievalSource.KNOWLEDGE);
            reasons.add("knowledge wording");
        }

        // "Plan my 3-day trip based on my previous preferences" →
        // memory/preferences plus live data plus knowledge: a synthesis request.
        if (signals.size() >= 2 && SYNTHESIS_RE.matcher(q).find()) {
            for (RetrievalSource source : PRIORITY) {
                if (signals.size() >= MAX_SOURCES) {
                    break;
                }
                if (!signals.add(source)) {
                    continue;
                }
                reasons.add("synthesis(+" + source.wire() + ")");
            }
        }

        if (signals.isEmpty()) {
            return RetrievalPlan.EMPTY;
        }

        // Enforce priority order + cap so a kitchen-sink question stays bounded.
        List<RetrievalSource> sources = new ArrayList<>();
        for (RetrievalSource source : PRIORITY) {
            if (signals.contains(source)) {
                sources.add(source);
            }
            if (sources.size() >= MAX_SOURCES) {
                break;
            }
        }

        String reason = reasons.isEmpty() ? "signals found" : String.join(" + ", reasons);
        RetrievalPlan.Budget budget = null;
        String knowledgeQuery = null;
        String planPlace = null;
        RetrievalPlan.LiveKind planKind = null;
        if (sources.contains(RetrievalSource.LIVE) && place != null) {
            planPlace = place;
            planKind = liveKind != null ? liveKind : RetrievalPlan.LiveKind.SIGHT;
            budget = parseBudget(q);
        }
        if (sources.contains(RetrievalSource.KNOWLEDGE)) {
            knowledgeQuery = q;
        }
        return new RetrievalPlan(sources, planPlace, planKind, budget, knowledgeQuery, reason);
    }
}
