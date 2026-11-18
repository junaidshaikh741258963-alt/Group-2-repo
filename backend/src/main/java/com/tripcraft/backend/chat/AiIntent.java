package com.tripcraft.backend.chat;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import com.tripcraft.backend.chat.AiSchema.AiReply;
import com.tripcraft.backend.chat.AiSchema.StructuredPlace;

/**
 * Turn-level intent + response policy for the structured chat route — the port
 * of {@code aiIntent.ts}.
 *
 * <p>The classifier decides, from the user's LATEST message and the trip state,
 * what shape this reply is allowed to take: how long the intro may be, how many
 * cards may ship, whether a day-by-day itinerary may ship at all, and whether
 * places already shown earlier in the conversation must be dropped.
 */
public final class AiIntent {

    private AiIntent() {
    }

    /** Flags matching the TS regexes' {@code i} flag (JS {@code /i} is Unicode-aware). */
    private static final int RE_FLAGS = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;

    /** What kind of answer this turn expects. */
    public enum AnswerKind {
        /** Explicit itinerary / day-by-day request. */
        PLAN,
        /** Modify the plan that is on the table. */
        EDIT,
        /** Short answer to the assistant's pending clarifying question. */
        STAGE,
        /** "show me hotels", "things to do in X". */
        RECOMMENDATION,
        /** "what did you recommend earlier?" → answer from history. */
        RECALL,
        /** Short follow-up question. */
        FOLLOWUP,
        /** Plain factual / knowledge question. */
        FACTUAL;
    }

    /**
     * Per-turn contract: what the classified intent allows this reply to
     * contain.
     *
     * @param kind           the answer kind
     * @param label          human line injected into the prompt ("This turn: …")
     * @param maxIntro       prompt budget for {@code intro} (characters)
     * @param maxPlaces      hard cap on cards shipped for this turn (0 = text-only)
     * @param allowItinerary whether a day-by-day itinerary is allowed
     * @param dedupe         drop places already shown earlier in this conversation
     * @param maxTokens      generation budget — a short question never needs 3k tokens
     * @param temperature    sampling temperature — factual turns stay deterministic
     */
    public record TurnIntent(
            AnswerKind kind,
            String label,
            int maxIntro,
            int maxPlaces,
            boolean allowItinerary,
            boolean dedupe,
            int maxTokens,
            double temperature) {
    }

    /** Input to {@link #classifyIntent}. */
    public record IntentInput(
            String question,
            boolean stagePending,
            boolean itineraryRequested,
            boolean hasPlan,
            boolean planHasItinerary) {
    }

    /**
     * Factual turns (what/when/is-it-safe, recall, stage answers) must not
     * drift, so they run cold; building or editing a plan benefits from some
     * variety. Always inside the 0.3–0.5 band the app is tuned for.
     */
    private static double temperature(AnswerKind kind) {
        return switch (kind) {
            case FACTUAL, RECALL, STAGE, FOLLOWUP -> 0.3;
            case RECOMMENDATION -> 0.4;
            case PLAN, EDIT -> 0.5;
        };
    }

    /* ————— signal patterns ————— */

    /** Recollection of something from THIS conversation. */
    private static final Pattern RECALL_RE = Pattern.compile(
            "\\b(what did i|what did you (?:say|mention|recommend|suggest|show|list|give)|did i|do you remember|i remember|earlier|previously|previous(?:ly)?|remember|you (?:said|mentioned|recommended|suggested)|as (?:i|you) (?:said|mentioned)|the (?:hotel|place|restaurant|city) i|my (?:pick|choice)|what were the|recap|summar(?:y|ise|ize))\\b",
            RE_FLAGS);

    /** Editing the plan that is on the table. */
    private static final Pattern MODIFY_RE = Pattern.compile(
            "\\b(cheaper|less expensive|more expensive|budget[- ]friendly|cut|remove|drop|swap|replace|change|reorder|reschedule|add (?:more|another|extra)|instead|too (?:packed|busy|full|long|much)|tighten|shorten|extend|fewer|different|make it|redo|revise|fix|shuffle)\\b",
            RE_FLAGS);

    /** Explicit plan / itinerary request. */
    private static final Pattern PLAN_RE = Pattern.compile(
            "\\b(?:itinerary|day[- ]by[- ]day|schedule|trip plan|full plan|whole trip|roadmap)\\b|\\b(?:plan|build|create|draft|design|write|put together|give me|make)\\s+(?:out\\s+)?(?:my|a|an|the|this|our)?\\s*(?:trip|itinerary|days?|schedule|plan|vacation|holiday)\\b|\\b\\d+\\s*[- ]\\s*(?:day|days|night|nights)\\b",
            RE_FLAGS);

    /** Knowledge / factual questions — prose answer, not a card dump. */
    private static final Pattern KNOWLEDGE_RE = Pattern.compile(
            "\\b(tell me about|what (?:is|are|was|were)|who (?:is|was)|how (?:does|do|did|is|are|long|far)|why (?:is|are|do|does)|explain|describe|history of|facts about|meaning of|origin of|difference between|best time|when should|is it safe|are they|does the|do the|safe|worth|how much does it cost|what time does)\\b|\\b(?:is|are|was|were|does|do|did|can|could|should|would|will|has|have)\\s+(?:it|there|this|that|they|them|you|we|i)\\b",
            RE_FLAGS);

    /** Opening travel intent — "I want to visit Tokyo." */
    private static final Pattern TRAVEL_INTENT_RE = Pattern.compile(
            "\\b(i want to|i'd like to|i would like to|we want to|we'd like to|we would like to|thinking of|planning to|hoping to|want to visit|visiting|visit|going to|heading to|travel to|trip to|vacation|holiday|explore|backpack|road trip)\\b",
            RE_FLAGS);

    /** Imperative discovery wording — a search, never a bare stage answer. */
    private static final Pattern SEARCH_VERB_RE = Pattern.compile(
            "\\b(show me|show|recommend|suggest|give me|list|find|search|looking for|where can|any good|best|top|things to|places to|what to|hidden gems|highlights)\\b",
            RE_FLAGS);

    /** Recommendation / discovery request. */
    private static final Pattern RECOMMEND_RE = Pattern.compile(
            "\\b(show me|recommend|recommendation|suggest|suggestions|give me|looking for|where can i|any good|best|top \\d+|things to do|things to see|places to (?:visit|see|eat|stay|go)|what to (?:see|do|eat|visit)|hidden gems|highlights|nearby)\\b|\\b(hotels?|hostels?|resorts?|restaurants?|caf[eé]s?|bars?|attractions?|sights?|museums?|food|cuisine|where to stay|where to eat|accommodation|lodging|activities|tours?)\\b",
            RE_FLAGS);

    /** Short affirmation of a pending plan request ("yes, build it"). */
    private static final Pattern AFFIRM_RE = Pattern.compile(
            "^\\s*(?:yes|yeah|yep|yup|sure|ok|okay|alright|go ahead|please do|do it|build it|make it|sounds good|let's do it|go for it|perfect|great|definitely|absolutely|cool)\\b",
            RE_FLAGS);

    private static final Pattern QUESTION_RE = Pattern.compile("\\?");

    private static int wordCount(String text) {
        String[] parts = Js.trim(text).split("\\s+");
        int count = 0;
        for (String part : parts) {
            if (!part.isEmpty()) {
                count++;
            }
        }
        return count;
    }

    /**
     * Classify the latest message. Order matters: recall and plan edits are more
     * specific than an itinerary request, which beats a knowledge question,
     * which beats a pending stage answer.
     */
    public static TurnIntent classifyIntent(IntentInput input) {
        String q = Js.trim(input.question());
        int words = wordCount(q);
        boolean short_ = words <= 10;
        boolean isQuestion = QUESTION_RE.matcher(q).find();

        if (RECALL_RE.matcher(q).find()) {
            return intent(AnswerKind.RECALL, "Recall — answer from this conversation, no new cards",
                    420, 0, false, true, 1600);
        }

        // Editing the plan on the table re-issues its cards/itinerary so the
        // renderer can update them — it must NOT be deduped against itself.
        if (input.hasPlan() && MODIFY_RE.matcher(q).find() && !PLAN_RE.matcher(q).find()) {
            return intent(AnswerKind.EDIT, "Edit the plan on the table — change only what was asked",
                    420, 12, input.planHasItinerary(), false, 3200);
        }

        if (PLAN_RE.matcher(q).find() || (input.itineraryRequested() && AFFIRM_RE.matcher(q).find())) {
            return intent(AnswerKind.PLAN, "Planning request — a full day-by-day answer is welcome",
                    640, 12, true, false, 3200);
        }

        if (KNOWLEDGE_RE.matcher(q).find()) {
            return intent(AnswerKind.FACTUAL, "Factual question — short prose answer, no trip rebuild",
                    340, 3, false, true, 1600);
        }

        // A short answer to the pending clarifying question ("Tokyo", "2 adults",
        // "Hotel Gracery Shinjuku") — the stage flow still needs its cards. Guarded so
        // a search ("show me hotels"), a travel opener and a question never land here.
        boolean stageAnswer =
                input.stagePending()
                        && short_
                        && !isQuestion
                        && !KNOWLEDGE_RE.matcher(q).find()
                        && !SEARCH_VERB_RE.matcher(q).find()
                        && !TRAVEL_INTENT_RE.matcher(q).find();
        if (stageAnswer) {
            return intent(AnswerKind.STAGE, "Stage answer — continue the flow, cards allowed",
                    400, 10, false, true, 2600);
        }

        if (RECOMMEND_RE.matcher(q).find() || TRAVEL_INTENT_RE.matcher(q).find()) {
            return intent(AnswerKind.RECOMMENDATION,
                    "Recommendation request — relevant cards plus one short line of prose",
                    440, 10, false, true, 2600);
        }

        if (short_) {
            return intent(AnswerKind.FOLLOWUP, "Follow-up — answer exactly this, keep it to 1-2 sentences",
                    340, 3, false, true, 1600);
        }

        return intent(AnswerKind.FACTUAL, "Factual question — short prose answer, no trip rebuild",
                340, 3, false, true, 1600);
    }

    private static TurnIntent intent(AnswerKind kind, String label,
            int maxIntro, int maxPlaces, boolean allowItinerary, boolean dedupe, int maxTokens) {
        return new TurnIntent(kind, label, maxIntro, maxPlaces, allowItinerary, dedupe,
                maxTokens, temperature(kind));
    }

    /* ————— post-generation policy ————— */

    /** Kinds that are *supposed* to ship cards — never let dedupe blank them out. */
    private static final Set<AnswerKind> CARD_KINDS =
            EnumSet.of(AnswerKind.PLAN, AnswerKind.EDIT, AnswerKind.STAGE, AnswerKind.RECOMMENDATION);

    public static String normalizePlaceKey(String name) {
        return Js.trim(Js.lower(name).replaceAll("[^\\p{L}\\p{N}]+", " "));
    }

    /**
     * Enforce the turn policy on a validated reply:
     *
     * <ul>
     *   <li>drop cards already shown earlier (unless this turn may repeat them),</li>
     *   <li>cap the card count to the intent,</li>
     *   <li>strip an itinerary when this turn did not ask for one.</li>
     * </ul>
     *
     * <p>Never touches prose and never invents content — it only narrows what
     * the model was allowed to emit for this intent.
     */
    public static AiReply applyTurnIntent(AiReply reply, TurnIntent turn, Set<String> shown) {
        List<StructuredPlace> places = reply.places();

        if (turn.dedupe() && shown.size() > 0 && turn.maxPlaces() > 0 && places.size() > 0) {
            Set<String> batch = new HashSet<>();
            List<StructuredPlace> kept = new ArrayList<>();
            for (StructuredPlace p : places) {
                String key = normalizePlaceKey(p.name());
                if (key.isEmpty() || shown.contains(key) || batch.contains(key)) {
                    continue;
                }
                batch.add(key);
                kept.add(p);
            }
            // A card kind that lost *every* card to dedupe is worse than a repeat:
            // keep the model's list rather than rendering an empty answer.
            boolean apply = kept.size() > 0 || places.size() == 0 || !CARD_KINDS.contains(turn.kind());
            if (apply) {
                places = kept;
            }
        }

        if (places.size() > turn.maxPlaces()) {
            places = new ArrayList<>(places.subList(0, turn.maxPlaces()));
        }

        return reply.withPlaces(places)
                .withItinerary(turn.allowItinerary() ? reply.itinerary() : List.of());
    }

    /** Topics where a wrong answer can actually put someone at risk or stranded. */
    private static final Pattern SAFETY_RE = Pattern.compile(
            "\\b(visa|visas|entry (?:requirement|requirement|permit)|passport|vaccin|immunis|immuniz|health (?:advis|ris|requir)|travel insurance|dangerous|safe(?:ty)?|crime|scam|tap water|drink(?:ing)? water|stomach|altitude sickness|emergency|embassy|curfew|protest|border (?:clos|clos)|declared|quarantine|permit(?:ted)? to (?:enter|travel))\\b",
            RE_FLAGS);

    /** The exact wording we promise the user on visa / health / safety answers. */
    public static final String SAFETY_DISCLAIMER = "Check official sources.";

    /** {@code new RegExp(SAFETY_DISCLAIMER, "i")} — the dot stays a wildcard, as in the TS. */
    private static final Pattern SAFETY_DISCLAIMER_RE =
            Pattern.compile(SAFETY_DISCLAIMER, RE_FLAGS);

    private static final Pattern SENTENCE_END_RE = Pattern.compile("(?:[.!?…])\\s*$");

    /**
     * Guarantee the disclaimer on visa / health / safety answers.
     *
     * <p>The system prompt asks the model to append it, but a missing
     * 24-character suffix must not depend on the model being obedient — so
     * enforce it here, once, after validation. Idempotent: a reply that already
     * carries it (or any variant of it) is returned untouched, and the intro is
     * re-clamped to the schema's 800-char ceiling afterwards.
     */
    public static AiReply applySafetyDisclaimer(AiReply reply, String question) {
        if (!SAFETY_RE.matcher(question).find()) {
            return reply;
        }
        if (SAFETY_DISCLAIMER_RE.matcher(reply.intro()).find()) {
            return reply;
        }

        String clipped = Js.slice(reply.intro(), 0, 800);
        String separator = SENTENCE_END_RE.matcher(clipped).find() ? " " : ". ";
        String intro = Js.trimEnd(clipped) + separator + SAFETY_DISCLAIMER;
        return reply.withIntro(Js.slice(intro, 0, 800));
    }
}
