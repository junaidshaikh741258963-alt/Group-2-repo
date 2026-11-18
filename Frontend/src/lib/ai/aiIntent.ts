/**
 * Turn-level intent + response policy for the structured chat route.
 *
 * Pure and dependency-free (type-only imports, relative paths) so it can be
 * exercised by a bare Node script without the Next.js module graph.
 *
 * The classifier decides, from the user's LATEST message and the trip state,
 * what shape this reply is allowed to take:
 *   - how long the intro may be,
 *   - how many cards may ship,
 *   - whether a day-by-day itinerary may ship at all,
 *   - whether places already shown earlier in the conversation must be dropped.
 *
 * The route injects the same decision into the system prompt (so the model
 * writes to the budget) AND applies it after validation (so a reply that
 * ignores the prompt still cannot re-dump the whole trip).
 */

import type { AiReply, StructuredPlace } from "./aiSchema";
import type { PlanningField } from "../tripProfile";

export type AnswerKind =
  | "plan" // explicit itinerary / day-by-day request
  | "edit" // modify the plan that is on the table
  | "stage" // short answer to the assistant's pending clarifying question
  | "recommendation" // "show me hotels", "things to do in X"
  | "recall" // "what did you recommend earlier?" → answer from history
  | "followup" // short follow-up question
  | "factual"; // plain factual / knowledge question

/** What kind of cards this turn is actually asking for. */
export type CardFocus = "destination" | "hotel" | "restaurant" | "attraction";

export interface TurnIntent {
  kind: AnswerKind;
  /** Human line injected into the prompt ("This turn: …"). */
  label: string;
  /** Prompt budget for `intro` (characters). */
  maxIntro: number;
  /** Hard cap on cards shipped for this turn (0 = text-only reply). */
  maxPlaces: number;
  /**
   * The single card category the user asked about ("hotels", "restaurants",
   * "things to do"). null = mixed/unknown, so any relevant category is fine.
   * Used by the prompt AND by `applyTurnIntent` to drop off-topic cards.
   */
  focus: CardFocus | null;
  /** Whether a day-by-day itinerary is allowed in this reply. */
  allowItinerary: boolean;
  /** Drop places that were already shown earlier in this conversation. */
  dedupe: boolean;
  /** Generation budget — a short question never needs 3k tokens. */
  maxTokens: number;
  /** Sampling temperature for this turn — factual turns stay deterministic. */
  temperature: number;
}

/**
 * Factual turns (what/when/is-it-safe, recall, stage answers) must not drift,
 * so they run cold; building or editing a plan benefits from some variety.
 * Always inside the 0.3–0.5 band the app is tuned for.
 */
const TEMPERATURE: Record<AnswerKind, number> = {
  factual: 0.3,
  recall: 0.3,
  stage: 0.3,
  followup: 0.3,
  recommendation: 0.4,
  plan: 0.5,
  edit: 0.5,
};

export interface IntentInput {
  /** The latest user message (trimmed). */
  question: string;
  /** The stage machine still owes an answer (nextField(profile) !== "done"). */
  stagePending: boolean;
  /**
   * The field the stage machine is waiting on (nextField(profile)). Used to
   * pick the shelf when the message does not name a category itself, so a
   * vague answer still moves the conversation one shelf at a time.
   */
  stageField?: PlanningField | null;
  /** The user has explicitly asked for a full itinerary (profile.itinerary). */
  itineraryRequested: boolean;
  /** A structured plan is on the table (last assistant reply had content). */
  hasPlan: boolean;
  /** …and that plan contains a day-by-day itinerary. */
  planHasItinerary: boolean;
}

/**
 * How many cards one reply may ship. A reply is ONE shelf, so a short list
 * reads as a considered shortlist rather than a search-results dump; the rest
 * of the trip lives in the itinerary.
 */
export const SHELF_MAX_CARDS = 6;

/* ————— signal patterns ————— */

/** Recollection of something from THIS conversation. */
const RECALL_RE =
  /\b(what did i|what did you (?:say|mention|recommend|suggest|show|list|give)|did i|do you remember|i remember|earlier|previously|previous(?:ly)?|remember|you (?:said|mentioned|recommended|suggested)|as (?:i|you) (?:said|mentioned)|the (?:hotel|place|restaurant|city) i|my (?:pick|choice)|what were the|recap|summar(?:y|ise|ize))\b/i;

/** Editing the plan that is on the table. */
const MODIFY_RE =
  /\b(cheaper|less expensive|more expensive|budget[- ]friendly|cut|remove|drop|swap|replace|change|reorder|reschedule|add (?:more|another|extra)|instead|too (?:packed|busy|full|long|much)|tighten|shorten|extend|fewer|different|make it|redo|revise|fix|shuffle)\b/i;

/** Explicit plan / itinerary request. */
const PLAN_RE =
  /\b(?:itinerary|day[- ]by[- ]day|schedule|trip plan|full plan|whole trip|roadmap)\b|\b(?:plan|build|create|draft|design|write|put together|give me|make)\s+(?:out\s+)?(?:my|a|an|the|this|our)?\s*(?:trip|itinerary|days?|schedule|plan|vacation|holiday)\b|\b\d+\s*[- ]\s*(?:day|days|night|nights)\b/i;

/** Knowledge / factual questions — prose answer, not a card dump. */
const KNOWLEDGE_RE =
  /\b(tell me about|what (?:is|are|was|were)|who (?:is|was)|how (?:does|do|did|is|are|long|far|much)|why (?:is|are|do|does)|explain|describe|history of|facts about|meaning of|origin of|difference between|best time|when should|is it safe|are they|does the|do the|safe|worth|how much does it cost|what time does)\b|\b(?:is|are|was|were|does|do|did|can|could|should|would|will|has|have)\s+(?:it|there|this|that|they|them|you|we|i)\b/i;

/** Opening travel intent — "I want to visit Tokyo." */
const TRAVEL_INTENT_RE =
  /\b(i want to|i'd like to|i would like to|we want to|we'd like to|we would like to|thinking of|planning to|hoping to|want to visit|visiting|visit|going to|heading to|travel to|trip (?:to|in)|weekend in|vacation|holiday|explore|backpack|road trip)\b/i;

/** Imperative discovery wording — a search, never a bare stage answer. */
const SEARCH_VERB_RE =
  /\b(show me|show|recommend|suggest|give me|list|find|search|looking for|where can|any good|best|top|things to|places to|what to|hidden gems|highlights)\b/i;

/** Recommendation / discovery request. */
const RECOMMEND_RE =
  /\b(show me|recommend|recommendation|suggest|suggestions|give me|looking for|where can i|any good|best|top \d+|things to do|things to see|places to (?:visit|see|eat|stay|go)|what to (?:see|do|eat|visit)|hidden gems|highlights|nearby)\b|\b(hotels?|hostels?|resorts?|restaurants?|caf[eé]s?|bars?|attractions?|sights?|museums?|food|cuisine|where to stay|where to eat|accommodation|lodging|activities|tours?)\b/i;

/**
 * "Which museums should I see?" is a shortlist request, even though the
 * generic KNOWLEDGE_RE also matches "should I". This narrower pattern wins
 * that tie: a question word + a card category means the user wants options.
 */
const CATEGORY_DISCOVERY_RE =
  /\b(?:which|what|where|best|top|any|some)\b[^.?!]{0,50}\b(?:hotels?|hostels?|resorts?|stays?|restaurants?|caf[eé]s?|bars?|museums?|galleries?|attractions?|sights?|things to do|places to (?:see|visit|eat|stay|go)|food|eat|dining|beaches?|activities|tours?|markets?)\b/i;

/** "Show me more", "any other restaurants", "something different". */
const MORE_RE =
  /\b(?:more|another|other|different|extra)\s+(?:options?|places?|hotels?|restaurants?|caf[eé]s?|choices?|suggestions?|ideas?|attractions?|things)\b|\b(?:show|give|see)\s+(?:me\s+)?more\b|\b(?:anything|something)\s+else\b/i;

/* ————— card focus (what the cards must actually be) ————— */

const HOTEL_RE =
  /\b(hotels?|hostels?|stays?|staying|lodging|accommodation|resorts?|airbnb|guest\s?house|where to (?:stay|sleep))\b/i;
const FOOD_RE =
  /\b(restaurants?|caf[eé]s?|coffee|food|eat|eating|dining|breakfast|lunch|dinner|brunch|bars?|pub|street food|cuisine|baker(?:y|ies)|pizzerias?|bistro|eatery)\b/i;
const ATTRACTION_RE =
  /\b(things to do|attractions?|sights?|museums?|activities|tours?|landmarks?|hidden gems|highlights|what to (?:see|do|visit)|places to (?:visit|see)|monuments?|galleries)\b/i;
/**
 * "Where should I go?" is its own shelf: the traveller is choosing a place,
 * not browsing the attractions inside one. Kept deliberately narrow so
 * "places to visit in Paris" still means sights.
 */
const DESTINATION_RE =
  /\b(destinations?|where (?:should|can|could|would|do) (?:i|we) (?:go|travel|visit|head)|where to (?:go|travel|base)|which (?:city|cities|country|countries|place|places|region|regions|island|islands)|best (?:places|cities|countries|destinations|regions|islands) to (?:go|travel|explore)|places to go|somewhere (?:warm|sunny|cheap|quiet|different|cold)|destination (?:ideas?|suggestions?)|trip ideas?|holiday ideas?)\b/i;

/**
 * Which card category the latest message names. Only a SINGLE unambiguous
 * category becomes a focus — "hotels with a good restaurant" stays mixed, so
 * the model is not forced to hide half the answer. A mixed turn still renders
 * one shelf: `applyTurnIntent` picks the dominant category.
 */
function detectFocus(q: string): CardFocus | null {
  const destination = DESTINATION_RE.test(q);
  const hotel = HOTEL_RE.test(q);
  const restaurant = FOOD_RE.test(q);
  const attraction = ATTRACTION_RE.test(q);
  if ([destination, hotel, restaurant, attraction].filter(Boolean).length !== 1) return null;
  return destination ? "destination" : hotel ? "hotel" : restaurant ? "restaurant" : "attraction";
}

/** The shelf the stage machine is about to ask about, as a card focus. */
function stageFocus(field: PlanningField | null | undefined): CardFocus | null {
  if (field === "destination") return "destination";
  if (field === "hotel") return "hotel";
  if (field === "restaurants") return "restaurant";
  if (field === "attractions") return "attraction";
  return null;
}

/** Short affirmation of a pending plan request ("yes, build it"). */
const AFFIRM_RE =
  /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|alright|go ahead|please do|do it|build it|make it|sounds good|let's do it|go for it|perfect|great|definitely|absolutely|cool)\b/i;

const QUESTION_RE = /\?/;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Classify the latest message. Order matters: recall and plan edits are more
 * specific than an itinerary request, which beats a knowledge question, which
 * beats a pending stage answer.
 */
export function classifyIntent(input: IntentInput): TurnIntent {
  const q = input.question.trim();
  const words = wordCount(q);
  const short = words <= 10;
  const isQuestion = QUESTION_RE.test(q);
  // A named category always wins; otherwise the shelf the stage machine is on
  // (when there is one) keeps the flow moving one category at a time.
  const named = detectFocus(q);
  const focus = named ?? stageFocus(input.stagePending ? input.stageField : null);

  if (RECALL_RE.test(q)) {
    return intent("recall", "Recall — answer from this conversation, no new cards", {
      maxIntro: 420,
      maxPlaces: 0,
      focus: null,
      allowItinerary: false,
      dedupe: true,
      maxTokens: 1600,
    });
  }

  // "Show me more" / "any other restaurants" is a NEW-options request, not a
  // plan edit: dedupe against everything already shown, then return new cards.
  if (MORE_RE.test(q)) {
    return intent(
      "recommendation",
      "More options — return places not already shown in this conversation",
      {
        maxIntro: 360,
        maxPlaces: focus ? 6 : 8,
        focus,
        allowItinerary: false,
        dedupe: true,
        maxTokens: 2400,
      }
    );
  }

  // Editing the plan on the table re-issues its cards/itinerary so the
  // renderer can update them — it must NOT be deduped against itself.
  if (input.hasPlan && MODIFY_RE.test(q) && !PLAN_RE.test(q)) {
    return intent("edit", "Edit the plan on the table — change only what was asked", {
      maxIntro: 420,
      maxPlaces: 8,
      focus: null,
      allowItinerary: input.planHasItinerary,
      dedupe: false,
      maxTokens: 3200,
    });
  }

  if (PLAN_RE.test(q) || (input.itineraryRequested && AFFIRM_RE.test(q))) {
    return intent("plan", "Planning request — a full day-by-day answer is welcome", {
      maxIntro: 640,
      maxPlaces: 8,
      focus: null,
      allowItinerary: true,
      dedupe: false,
      maxTokens: 3200,
    });
  }

  // "Where should I go?" is a discovery request, not a short follow-up. It
  // gets the destination shelf even when phrased as a question ("where should
  // I go in October?") or as a seasonal mood ("somewhere warm in January").
  // Runs after PLAN so "plan a trip — where should I go?" still builds a plan.
  if (DESTINATION_RE.test(q)) {
    return intent("recommendation", "Destination discovery — destination cards only", {
      maxIntro: 420,
      maxPlaces: 6,
      focus: "destination",
      allowItinerary: false,
      dedupe: true,
      maxTokens: 2400,
    });
  }

  // A generic "should I" / "what is" question is prose, but a question that
  // names a card category ("which museums should I see") is a shortlist
  // request and must keep its card budget.
  if (KNOWLEDGE_RE.test(q) && !CATEGORY_DISCOVERY_RE.test(q)) {
    return intent("factual", "Factual question — short prose answer, no trip rebuild", {
      maxIntro: 340,
      maxPlaces: 0,
      focus: null,
      allowItinerary: false,
      dedupe: true,
      maxTokens: 1600,
    });
  }

  // A short answer to the pending clarifying question ("Tokyo", "2 adults",
  // "Hotel Gracery Shinjuku") — the stage flow still needs its cards. Guarded so
  // a search ("show me hotels"), a travel opener and a question never land here.
  const stageAnswer =
    input.stagePending &&
    short &&
    !isQuestion &&
    !KNOWLEDGE_RE.test(q) &&
    !CATEGORY_DISCOVERY_RE.test(q) &&
    !SEARCH_VERB_RE.test(q) &&
    !TRAVEL_INTENT_RE.test(q);
  if (stageAnswer) {
    return intent("stage", "Stage answer — continue the flow, cards allowed", {
      maxIntro: 400,
      maxPlaces: 6,
      focus,
      allowItinerary: false,
      dedupe: true,
      maxTokens: 2400,
    });
  }

  if (RECOMMEND_RE.test(q) || TRAVEL_INTENT_RE.test(q)) {
    return intent(
      "recommendation",
      "Recommendation request — relevant cards plus one short line of prose",
      {
        maxIntro: 420,
        maxPlaces: focus ? 6 : 8,
        focus,
        allowItinerary: false,
        dedupe: true,
        maxTokens: 2400,
      }
    );
  }

  if (short) {
    return intent("followup", "Follow-up — answer exactly this, keep it to 1-2 sentences", {
      maxIntro: 340,
      maxPlaces: 0,
      focus: null,
      allowItinerary: false,
      dedupe: true,
      maxTokens: 1600,
    });
  }

  return intent("factual", "Factual question — short prose answer, no trip rebuild", {
    maxIntro: 340,
    maxPlaces: 0,
    focus: null,
    allowItinerary: false,
    dedupe: true,
    maxTokens: 1600,
  });
}

function intent(
  kind: AnswerKind,
  label: string,
  rest: Omit<TurnIntent, "kind" | "label" | "temperature">
): TurnIntent {
  return { kind, label, temperature: TEMPERATURE[kind], ...rest };
}

/* ————— post-generation policy ————— */

/**
 * Kinds where an all-deduped list is worse than a repeat: the plan / stage flow
 * needs a visible set to work with. A pure recommendation request is NOT here —
 * showing the same cards again is exactly what "avoid repeats" forbids.
 */
const KEEP_WHEN_DEDUPED: ReadonlySet<AnswerKind> = new Set<AnswerKind>(["plan", "edit", "stage"]);

export function normalizePlaceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Map a free-text model category onto the turn's card focus. */
function placeFocus(category: string): CardFocus | null {
  const c = category.toLowerCase();
  if (/\b(hotel|hostel|stay|lodge|lodging|resort|riad|inn|guest\s?house|apartment)\b/.test(c))
    return "hotel";
  if (
    /\b(restaurant|cafe|café|coffee|food|dining|bar|pub|bakery|bistro|eatery|pizzeria|brunch)\b/.test(
      c
    )
  )
    return "restaurant";
  if (
    /\b(attraction|sight|museum|landmark|activity|tour|park|monument|gallery|beach|temple|castle)\b/.test(
      c
    )
  )
    return "attraction";
  // Checked last so "island resort" stays a hotel and "city hotel" stays a
  // hotel; an explicit destination label lands here.
  if (
    /\b(destination|city|country|region|island|neighbourhood|neighborhood|town|village|province|state|area)\b/.test(
      c
    )
  )
    return "destination";
  return null;
}

/** The category with the most entries; ties go to whichever came first. */
function dominantCategory(places: StructuredPlace[]): CardFocus | null {
  const counts = new Map<CardFocus, number>();
  let best: CardFocus | null = null;
  for (const p of places) {
    const focus = placeFocus(p.category);
    if (!focus) continue;
    const next = (counts.get(focus) ?? 0) + 1;
    counts.set(focus, next);
    if (best === null) best = focus;
    else if (next > (counts.get(best) ?? 0)) best = focus;
  }
  return best;
}

/**
 * Enforce the turn policy on a validated reply:
 *   - keep ONE card category (the shelf this turn is about),
 *   - drop cards already shown earlier (unless this turn may repeat them),
 *   - cap the shelf to its budget,
 *   - strip an itinerary when this turn did not ask for one.
 *
 * Never touches prose and never invents content — it only narrows what the
 * model was allowed to emit for this intent.
 */
export function applyTurnIntent(
  reply: AiReply,
  turn: TurnIntent,
  shown: ReadonlySet<string>
): AiReply {
  let places: StructuredPlace[] = reply.places;

  if (turn.dedupe && shown.size > 0 && turn.maxPlaces > 0 && places.length > 0) {
    const batch = new Set<string>();
    const kept = places.filter((p) => {
      const key = normalizePlaceKey(p.name);
      if (!key || shown.has(key) || batch.has(key)) return false;
      batch.add(key);
      return true;
    });
    // Plan/stage answers need something to render; a pure "show me more"
    // recommendation is allowed to return no cards rather than repeat itself.
    const apply = kept.length > 0 || !KEEP_WHEN_DEDUPED.has(turn.kind);
    if (apply) places = kept;
  }

  // ONE shelf per reply. A mixed dump of hotels + restaurants + sights is
  // exactly the "all the cards at once" wall this policy exists to prevent:
  // the traveller asks for one thing, gets one strip, and asks for the next.
  if (places.length > 1) {
    const keep = turn.focus ?? dominantCategory(places);
    if (keep) {
      const only = places.filter((p) => placeFocus(p.category) === keep);
      // A model that labelled everything oddly must not lose the answer.
      if (only.length > 0) places = only;
    }
  }

  const cap = Math.min(turn.maxPlaces, SHELF_MAX_CARDS);
  if (places.length > cap) places = places.slice(0, cap);

  return {
    ...reply,
    places,
    itinerary: turn.allowItinerary ? reply.itinerary : [],
  };
}

/** Topics where a wrong answer can actually put someone at risk or stranded. */
const SAFETY_RE =
  /\b(visa|visas|entry (?:requirement|requirement|permit)|passport|vaccin|immunis|immuniz|health (?:advis|ris|requir)|travel insurance|dangerous|safe(?:ty)?|crime|scam|tap water|drink(?:ing)? water|stomach|altitude sickness|emergency|embassy|curfew|protest|border (?:clos|clos)|declared|quarantine|permit(?:ted)? to (?:enter|travel))\b/i;

/** The exact wording we promise the user on visa / health / safety answers. */
export const SAFETY_DISCLAIMER = "Check official sources.";

/**
 * Guarantee the disclaimer on visa / health / safety answers.
 *
 * The system prompt asks the model to append it, but a missing 24-character
 * suffix must not depend on the model being obedient — so enforce it here,
 * once, after validation. Idempotent: a reply that already carries it (or any
 * variant of it) is returned untouched, and the intro is re-clamped to the
 * schema's 800-char ceiling afterwards.
 */
export function applySafetyDisclaimer(reply: AiReply, question: string): AiReply {
  if (!SAFETY_RE.test(question)) return reply;
  if (new RegExp(SAFETY_DISCLAIMER, "i").test(reply.intro)) return reply;

  const clipped = reply.intro.slice(0, 800);
  const separator = /(?:[.!?…])\s*$/.test(clipped) ? " " : ". ";
  const intro = `${clipped.trimEnd()}${separator}${SAFETY_DISCLAIMER}`;
  return { ...reply, intro: intro.slice(0, 800) };
}
