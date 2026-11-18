/**
 * Intent routing: decide WHICH retrieval sources (if any) serve this question.
 *
 * The chat's stage-machine flow ("Tokyo", "2 adults", "Budget") must run with
 * zero retrieval — those messages carry no question worth fetching for. Only
 * when a signal below fires do we retrieve, and each source has its own gate
 * so we never pull live API data for a conversational aside.
 */

import type { RetrievalContext, RetrievalPlan, RetrievalSource } from "./types";
import { EMPTY_PLAN } from "./types";

/** Recollection: the user is asking about something from this conversation/trip. */
const RECALL_RE =
  /\b(what did i|which .{0,30} did i|did i|do i remember|do you remember|i chose|i picked|i picked|we picked|we chose|we decided|my (?:previous|earlier|last|own) (?:trip|choice|pick|selection|preferences?)|earlier|previously|previous(?:ly)?|remember|you (?:said|mentioned|recommended)|as (?:i|you) (?:said|mentioned)|the hotel i|the dates i|my pick|my choice|like i said|going back to|change my mind about|final(?:ly)? (?:chose|picked|decided))\b/i;

/** User-specific preference: retrieval from profile + mined preference lines. */
const PREFERENCE_RE =
  /\b(i (?:prefer|like|love|hate|dislike|avoid|want|need|always|never|only|am into|am a)|we (?:prefer|like|love|always|never|only|are)|based on my|my (?:preferences?|taste|style|budget|interests)|as per my|remember that i|vegetarian|vegan|no (?:alcohol|meat|spicy)|allergic)\b/i;

const LIVE_KIND_RES: Array<{ kind: "hotel" | "food" | "sight" | "weather"; re: RegExp }> = [
  {
    kind: "hotel",
    re: /\b(hotels?|hostels?|resorts?|accommodation|lodging|where to (?:stay|sleep)|places to stay|stays|guesthouses?|airbnb)\b/i,
  },
  {
    kind: "food",
    re: /\b(restaurants?|caf[eé]s?|dining|eat(?:ing)?|food|cuisine|street food|breakfast|brunch|lunch|dinner|ramen|noodles?|pizza|bagels?|baker(?:y|ies)|coffee|delis?|eateries|diners?|bars?)\b/i,
  },
  {
    kind: "weather",
    re: /\b(weather|forecast|rain(?:ing)?|temperature|how (?:hot|cold|warm)|sunny|snow(?:ing)?)\b/i,
  },
  {
    kind: "sight",
    re: /\b(attractions?|things to (?:do|see|visit|go)|places to (?:visit|see|go)|what to (?:see|do)|sights|sightseeing|activities|tours?|points? of interest|landmarks?|museums?|galleries?|monuments?|shops?|markets?|show me|explore)\b/i,
  },
];

/** Needs *current* data regardless of category (prices, availability, timing). */
const VOLATILE_RE =
  /\b(under|below|less than|upto|up to|per night|tonight|tomorrow|today|this weekend|open now|available|availability|prices?|costs?|fare|how much)\b/i;

/** Encyclopedic / how-it-works questions → knowledge base (web fallback). */
const KNOWLEDGE_RE =
  /\b(history|historical|tell me about|facts? about|meaning|origin|founded|built|century|culture|cultural|customs?|traditions?|etiquette|visa|passport|entry requirement|best time|when should i (?:visit|go|travel)|climate|language|religion|tipping|\btips?\b|dress code|is .{0,40} safe|safety|how does .{0,40} work|why (?:is|do|does|are)|what (?:is|are|was|were) (?:the )?|what (?:do|does|did|can|should)|explain|define|who (?:was|built|founded)|difference between|schengen|jr pass|e-?visa|irctc|esim|sim card|jet lag|insurance|packing|vegetarian|vegan|solo travel|family travel|layover|connection|budget(?:ing)?|booking|etiquet)/i;

/** Multi-source synthesis ("plan … based on my previous preferences"). */
const SYNTHESIS_RE = /\b(plan|build|create|design|itinerary|day[- ]by[- ]day|schedule)\b/i;

/**
 * Destination-discovery questions ("where should I go in October", "which
 * cities in Japan") are planning questions, not encyclopedic ones. They still
 * deserve retrieval: seasonality guidance, saved preferences and the trip
 * board all make the shortlist more personal than a generic list.
 */
const DESTINATION_DISCOVERY_RE =
  /\b(where (?:should|can|could|would|do) (?:i|we) (?:go|travel|visit|head)|where to (?:go|travel|base)|which (?:city|cities|country|countries|place|places|region|island|islands)|best (?:destinations?|places|cities|countries|regions|islands?) (?:to|for) (?:go|travel|explore)|destination (?:ideas?|suggestions?)|somewhere (?:warm|sunny|cheap|quiet|different|cold)|trip ideas?|holiday ideas?)\b/i;

/** A request for one place category — enough to ground it in the KB too. */
const CATEGORY_REQUEST_RE =
  /\b(hotels?|hostels?|stays?|accommodation|lodging|restaurants?|caf[eé]s?|food|eat|dining|things to do|attractions?|sights?|museums?|landmarks?|activities|tours?|galleries?|beaches?|neighbo[u]?rhoods?|where to (?:stay|eat))\b/i;

/**
 * Knowledge queries need the vocabulary the corpus uses. Wikivoyage sections
 * are titled "See", "Do", "Eat", "Sleep" — a chat question says "things to do",
 * "food" and "stays". The expansion is appended only; the original question
 * still drives the ranking and the relevance gate.
 */
const CATEGORY_EXPANSION: Array<[RegExp, string]> = [
  [
    /\b(things to do|attractions?|sights?|museums?|landmarks?|activities|tours?|galleries?)\b/i,
    "see do attractions museums landmarks",
  ],
  [/\b(restaurants?|caf[eé]s?|food|eat|dining|street food)\b/i, "eat drink food restaurants"],
  [
    /\b(hotels?|stays?|staying|accommodation|lodging|hostels?|resorts?)\b/i,
    "sleep hotels accommodation",
  ],
  [/\b(beaches?|coast|island)\b/i, "beaches coast island"],
  [/\b(neighbo[u]?rhoods?|areas?|where to stay)\b/i, "districts neighbourhoods areas"],
];

const MAX_SOURCES = 4;
const PRIORITY: RetrievalSource[] = ["memory", "preferences", "live", "knowledge"];

/** Explicit search intent — needed when the place isn't named in the question. */
const SEARCHISH_RE =
  /\b(show me|find|search|recommend|suggest|give me|list|looking for|need|want|where can|any good|good|nice|best|top)\b/i;

const CURRENCY_PATTERNS: Array<[RegExp, string]> = [
  [/(?:₹|inr|rs\.|rupees?)/i, "INR"],
  [/(?:\$|usd|dollars?)/i, "USD"],
  [/(?:€|eur|euros?)/i, "EUR"],
  [/(?:£|gbp|pounds?)/i, "GBP"],
];

const BUDGET_LEAD =
  /\b(?:under|below|less than|upto|up to|max|within|around|about|budget(?:\s+of)?)\s+([^!?\n]{0,28})/i;

function currencyIn(segment: string): string | null {
  for (const [re, code] of CURRENCY_PATTERNS) {
    if (re.test(segment)) return code;
  }
  return null;
}

/**
 * Parse "under ₹10,000" / "10000 rupees" / "below $200".
 * A currency signal is required — a bare number's units are ambiguous.
 */
export function parseBudget(question: string): { amount: number; currency: string } | undefined {
  const lead = question.match(BUDGET_LEAD);
  if (lead?.[1]) {
    const segment = lead[1];
    const currency = currencyIn(segment);
    const num = segment.match(/(\d[\d,]*)/);
    if (currency && num) {
      const amount = Number(num[1].replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0) return { amount, currency };
    }
  }
  // Bare "₹10,000" / "$200" without a qualifier.
  for (const [re, code] of CURRENCY_PATTERNS) {
    const m = question.match(new RegExp(`${re.source}\\s*([\\d,]+)`, "i"));
    if (m?.[1]) {
      const amount = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0) return { amount, currency: code };
    }
  }
  return undefined;
}

/** Strict: a place clearly referenced by the question ("hotels in Tokyo"). */
export function placeFromQuestion(ctx: RetrievalContext): string | null {
  const q = ctx.question.trim();
  // Capitalised run after a locator preposition → multi-word-safe, never
  // swallows trailing sentence words ("in Tokyo are under" → "Tokyo").
  // An article after the preposition is skipped ("near the Eiffel Tower"), but
  // the captured name must still start capitalised — so "in the middle of"
  // never resolves to a place named "middle".
  const caps = q.match(
    /\b(?:in|near|around|to|from|at)\s+(?:the\s+|this\s+|that\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/
  );
  if (caps?.[1]) return caps[1].trim();
  // Single lowercase word ("hotels in tokyo") — one word only, and never a
  // verb ("want to eat" must not resolve to place "eat").
  const lower = q.match(/\b(?:in|near|around|from|at)\s+([a-z][a-z'-]{2,24})(?=[\s,.!?]|$)/);
  if (lower?.[1] && !NOT_A_PLACE.has(lower[1])) return lower[1];
  const toLower = q.match(/\bto\s+([a-z][a-z'-]{2,24})(?=[\s,.!?]|$)/);
  if (toLower?.[1] && !NOT_A_PLACE.has(toLower[1])) return toLower[1];
  return null;
}

/** Loose: any capitalised proper-noun run anywhere in the question. */
export function loosePlaceFromQuestion(ctx: RetrievalContext): string | null {
  const words = ctx.question.trim().split(/\s+/);
  const runs: string[] = [];
  let run: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z-]/g, "");
    const isProper = /^[A-Z][a-zA-Z-]{2,}$/.test(w) && !NON_PLACE_WORDS.has(w.toLowerCase());
    if (isProper) {
      run.push(w);
    } else if (run.length) {
      runs.push(run.join(" "));
      run = [];
    }
  }
  if (run.length) runs.push(run.join(" "));
  if (runs.length === 0) return null;
  // Longest run wins: "Tokyo Imperial Palace" over a stray single capital.
  return runs.sort((a, b) => b.length - a.length)[0];
}

const NOT_A_PLACE = new Set([
  "eat",
  "go",
  "see",
  "visit",
  "do",
  "stay",
  "sleep",
  "buy",
  "have",
  "make",
  "take",
  "spend",
  "plan",
  "book",
  "get",
  "fly",
  "drive",
  "walk",
  "swim",
  "check",
  "find",
  "want",
  "need",
  "like",
  "love",
  "try",
  "explore",
  "relax",
  "this",
  "that",
  "the",
  "some",
  "any",
  "good",
  "great",
  "nice",
  "best",
  "where",
  "what",
  "when",
  "how",
  "why",
  "my",
  "our",
  "your",
  "me",
  "you",
  "them",
  "us",
  "it",
]);

const NON_PLACE_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "you",
  "your",
  "about",
  "please",
  "tell",
  "what",
  "where",
  "when",
  "which",
  "how",
  "why",
  "give",
  "show",
  "find",
  "best",
  "top",
  "this",
  "that",
  "there",
  "here",
  "hotel",
  "hotels",
  "trip",
  "day",
  "days",
  "good",
  "nice",
  "want",
  "need",
  "like",
  "love",
  "plan",
  "build",
  "create",
  "make",
  "some",
  "any",
  "really",
  "very",
  "can",
  "could",
  "would",
  "should",
  "into",
  "over",
  "under",
  "next",
  "last",
  "it",
  "its",
  "he",
  "she",
  "we",
  "they",
  "his",
  "her",
  "our",
  "their",
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "being",
  "been",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "not",
  "yes",
  "now",
  "then",
  "also",
  "just",
  "only",
  "even",
  "still",
]);

/** Place for live lookup: strict question match → trip profile → loose match. */
export function resolvePlace(ctx: RetrievalContext): string | null {
  const strict = placeFromQuestion(ctx);
  if (strict) return strict;
  const dest = ctx.profile.destination;
  if (dest && dest.trim()) return dest.trim();
  return loosePlaceFromQuestion(ctx);
}

function detectLiveKind(question: string): "hotel" | "food" | "sight" | "weather" | null {
  for (const { kind, re } of LIVE_KIND_RES) {
    if (re.test(question)) return kind;
  }
  if (VOLATILE_RE.test(question)) return "sight"; // price/availability on a named place
  return null;
}

/**
 * Query handed to the local knowledge store. Adds the place when the question
 * omits it ("show me hotels" inside a Tokyo trip) and the corpus vocabulary for
 * the requested category. Destination discovery deliberately does NOT prepend
 * the profile destination — the traveller is choosing a new one.
 */
/**
 * Narrow the live Overpass query to what the traveller actually asked for.
 * "Tourist attractions" returns a generic square-and-church list even when the
 * question is specifically about museums; the model then has no museum names
 * to card, so it falls back to prose.
 */
export function liveQueryFor(
  kind: "hotel" | "food" | "sight" | "weather",
  question: string
): string {
  if (kind === "sight") {
    if (/\bmuseums?\b/i.test(question)) return "museums";
    if (/\bgalleries?|art\b/i.test(question)) return "art galleries";
    if (/\bbeaches?\b/i.test(question)) return "beaches";
    if (/\bparks?\b/i.test(question)) return "parks";
    if (/\bmarkets?\b/i.test(question)) return "markets";
    if (/\blandmarks?|monuments?\b/i.test(question)) return "landmarks";
    if (/\bchurches?|cathedrals?|temples?|shrines?\b/i.test(question)) return "churches";
    return "tourist attractions";
  }
  if (kind === "food") {
    if (/\bcaf[eé]s?|coffee\b/i.test(question)) return "cafes";
    if (/\bbars?|pub\b/i.test(question)) return "bars";
    if (/\bstreet food\b/i.test(question)) return "street food";
    return "restaurants";
  }
  return "";
}

export function knowledgeQueryFor(
  question: string,
  place: string | null,
  destinationDiscovery = false
): string {
  const q = question.trim();
  const extras = new Set<string>();
  if (destinationDiscovery) extras.add("when to go best time season climate");
  for (const [re, extra] of CATEGORY_EXPANSION) {
    if (re.test(q)) extras.add(extra);
  }
  const placeBit =
    !destinationDiscovery && place && !q.toLowerCase().includes(place.toLowerCase()) ? place : "";
  return [placeBit, q, [...extras].join(" ")].filter(Boolean).join(" ").trim();
}

/**
 * Pure function: question + context → retrieval plan. No I/O.
 */
export function planRetrieval(ctx: RetrievalContext): RetrievalPlan {
  const q = ctx.question.trim();
  if (!q) return EMPTY_PLAN;

  const signals = new Set<RetrievalSource>();
  const reasons: string[] = [];

  const isRecall = RECALL_RE.test(q);
  if (isRecall) {
    signals.add("memory");
    reasons.push("recall wording");
  }
  if (PREFERENCE_RE.test(q)) {
    signals.add("preferences");
    reasons.push("preference wording");
  }

  const liveKind = detectLiveKind(q);
  const placeInQuestion = placeFromQuestion(ctx);
  const place = placeInQuestion ?? resolvePlace(ctx);
  // Live data only when the question *asks* for it: it names the place itself,
  // or it is phrased as a search/interrogative/current-fact question. A bare
  // hotel name ("Hotel Gracery Shinjuku" — a stage answer) never triggers a
  // live API call.
  const wantsData = /\?/.test(q) || VOLATILE_RE.test(q) || SEARCHISH_RE.test(q);
  const wantsLiveData =
    liveKind !== null && place !== null && (placeInQuestion !== null || wantsData);
  if (liveKind && wantsLiveData) {
    signals.add("live");
    reasons.push(`live(${liveKind})`);
  }

  const destinationDiscovery = DESTINATION_DISCOVERY_RE.test(q);
  // A shortlist is more personal when it knows what the traveller already
  // liked/saved. Only worth a retrieval when there is something to retrieve.
  if (
    destinationDiscovery &&
    !isRecall &&
    (ctx.profile.interests || ctx.tripItems.length > 0) &&
    !signals.has("preferences")
  ) {
    signals.add("preferences");
    reasons.push("destination discovery(+preferences)");
  }

  // A recollection question is about THIS conversation — KB entries that share
  // its wording ("what did I pick" → travel insurance) are noise, so knowledge
  // only joins when the question is genuinely encyclopedic AND not a recall.
  //
  // Two extra doors: destination discovery (seasonality/orientation), and a
  // category request that names a place ("best museums in Madrid"). The latter
  // is exactly where a live OSM sweep is thin but Wikivoyage's See/Do/Eat/Sleep
  // sections are strong, so both sources ground the same answer.
  const groundedRecommendation =
    !isRecall &&
    placeInQuestion !== null &&
    CATEGORY_REQUEST_RE.test(q) &&
    (SEARCHISH_RE.test(q) ||
      /\?|things to do|what to (?:see|do|eat)|where to (?:stay|eat)/i.test(q));
  if (
    !isRecall &&
    (destinationDiscovery ||
      groundedRecommendation ||
      (KNOWLEDGE_RE.test(q) && /\?|tell me|explain|describe|about|how (?:do|does|to)\b/i.test(q)))
  ) {
    signals.add("knowledge");
    reasons.push(
      destinationDiscovery
        ? "destination discovery"
        : groundedRecommendation
          ? "grounded recommendations"
          : "knowledge wording"
    );
  }

  // "Plan my 3-day trip based on my previous preferences" → memory/preferences
  // plus live data plus knowledge: a synthesis request.
  if (signals.size >= 2 && SYNTHESIS_RE.test(q)) {
    for (const s of PRIORITY) {
      if (signals.size >= MAX_SOURCES) break;
      if (!signals.has(s)) {
        signals.add(s);
        reasons.push(`synthesis(+${s})`);
      }
    }
  }

  if (signals.size === 0) return EMPTY_PLAN;

  // Enforce priority order + cap so a kitchen-sink question stays bounded.
  const sources = PRIORITY.filter((s) => signals.has(s)).slice(0, MAX_SOURCES);

  const plan: RetrievalPlan = {
    sources,
    reason: reasons.join(" + ") || "signals found",
  };
  if (sources.includes("live") && place) {
    plan.place = place;
    const kind = liveKind ?? "sight";
    plan.liveKind = kind;
    const liveQuery = liveQueryFor(kind, q);
    if (liveQuery) plan.liveQuery = liveQuery;
    const budget = parseBudget(q);
    if (budget) plan.budget = budget;
  }
  if (sources.includes("knowledge")) {
    plan.knowledgeQuery = knowledgeQueryFor(q, place, destinationDiscovery);
    if (groundedRecommendation) plan.groundedRecommendation = true;
  }
  return plan;
}
