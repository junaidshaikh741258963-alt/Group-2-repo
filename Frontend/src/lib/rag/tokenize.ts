/**
 * Light-weight text normalization for retrieval.
 *
 * Deterministic and dependency-free: stopwords, a crude plural stem, and a
 * small synonym table so "chose / picked / selected" all match "choose".
 * Good retrieval recall without an embedding API call per query.
 */

const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his i " +
    "if in into is it its me my no not of on or our out over she so than that the their them then " +
    "there these they this to too up us very was we were what when where which who why will with " +
    "would you your about after again also any because before being between both during each few " +
    "more most other some such through under until while am does don how just most only own same " +
    "should some now tell please give shows show got get gets go going gonna hey ok okay yeah hi " +
    "much many one two like im i'm i've i'd it's thats that's there's here's let's"
  ).split(" ")
);

/** Question words that carry no retrieval signal on their own. */
const QUESTION_WORDS = new Set([
  "what",
  "whats",
  "what's",
  "who",
  "whom",
  "which",
  "where",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "and",
  "or",
  "my",
  "me",
  "i",
]);

/** Map surface forms → one canonical token so related phrasings collide. */
const SYN: Record<string, string> = {
  hotels: "hotel",
  hotel: "hotel",
  stays: "stay",
  stay: "stay",
  lodging: "hotel",
  hostels: "hostel",
  resorts: "resort",
  accommodations: "accommodation",
  restaurants: "restaurant",
  eateries: "restaurant",
  cafes: "cafe",
  cafés: "cafe",
  foods: "food",
  cuisines: "cuisine",
  dishes: "dish",
  prices: "price",
  pricing: "price",
  costs: "cost",
  fare: "price",
  fares: "price",
  expenses: "cost",
  budgeting: "budget",
  budgets: "budget",
  attractions: "attraction",
  sights: "sight",
  sightseeings: "sightseeing",
  places: "place",
  spots: "spot",
  locations: "location",
  destinations: "destination",
  cities: "city",
  countries: "country",
  trips: "trip",
  travels: "travel",
  chosen: "choose",
  chose: "choose",
  picks: "choose",
  pick: "choose",
  picking: "choose",
  choosing: "choose",
  selected: "choose",
  selecting: "choose",
  selection: "choose",
  decided: "decide",
  decision: "decide",
  decisions: "decide",
  prefer: "prefer",
  prefers: "prefer",
  preferred: "prefer",
  preference: "prefer",
  preferences: "prefer",
  liking: "like",
  liked: "like",
  loves: "love",
  loved: "love",
  plan: "plan",
  plans: "plan",
  planning: "plan",
  planned: "plan",
  histories: "history",
  historical: "history",
  historic: "history",
  cultures: "culture",
  cultural: "culture",
  customs: "custom",
  traditions: "tradition",
  traditional: "tradition",
  etiquettes: "etiquette",
  weathers: "weather",
  forecast: "weather",
  forecasts: "weather",
  tickets: "ticket",
  visas: "visa",
  passports: "passport",
  peoples: "people",
  person: "people",
  persons: "people",
  travelers: "people",
  travellers: "people",
  adult: "adult",
  adults: "adult",
  kids: "kid",
  children: "child",
  days: "day",
  nights: "night",
  weeks: "week",
  months: "month",
  years: "year",
  museums: "museum",
  temples: "temple",
  shrines: "shrine",
  beaches: "beach",
  mountains: "mountain",
  islands: "island",
  markets: "market",
  parks: "park",
  neighborhoods: "neighbourhood",
  areas: "area",
  buses: "bus",
  trains: "train",
  metros: "metro",
  subways: "subway",
  trams: "tram",
  flights: "flight",
  planes: "plane",
  airports: "airport",
  book: "book",
  booking: "book",
  reserve: "book",
  reservation: "book",
  cheapest: "cheap",
  cheaper: "cheap",
  expensive: "cheapness",
  near: "near",
  nearby: "near",
  around: "near",
  close: "near",
  best: "good",
  top: "good",
  great: "good",
  nice: "good",
  info: "information",
  infoabout: "information",
  details: "detail",
  based: "base",
  itinerary: "itinerary",
  itineraries: "itinerary",
};

const DOUBLE_END = /(.)\1$/;

function stem(token: string): string {
  const syn = SYN[token];
  if (syn) return syn;
  if (token.length >= 6 && token.endsWith("ing")) {
    const cut = token.slice(0, -3);
    return cut.length > 3 && DOUBLE_END.test(cut) ? cut.slice(0, -1) : cut;
  }
  if (token.length >= 5 && token.endsWith("ed")) {
    const cut = token.slice(0, -2);
    return cut.length > 3 && DOUBLE_END.test(cut) ? cut.slice(0, -1) : cut;
  }
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

/** Split → lowercase → strip punctuation/diacritics → stem. Keeps order. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9₹$€£#]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(stem);
}

/** Tokens that actually carry meaning for matching. */
export function significantTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Question-only tokens ("what", "did", "i"…) — excluded from relevance math. */
export function queryTokens(text: string): string[] {
  return significantTokens(text).filter((t) => !QUESTION_WORDS.has(t));
}

/**
 * Generic capitals that are category words, not entities — excluded from
 * `entityTokens` so "Hotel Gracery" doesn't demand the literal word "hotel".
 * Pronouns/determiners/question words already live in STOP/QUESTION_WORDS.
 */
const NON_ENTITY = new Set([
  "hotel",
  "hotels",
  "hostel",
  "hostels",
  "restaurant",
  "restaurants",
  "museum",
  "museums",
  "park",
  "parks",
  "street",
  "streets",
  "tower",
  "palace",
  "castle",
  "city",
  "cities",
  "town",
  "trip",
  "day",
  "days",
  "thanks",
  "thank",
  "nice",
  "good",
  "great",
  "cool",
  "okay",
  "perfect",
  "exact",
  "well",
  "love",
  "hi",
  "hello",
  "hey",
  "bye",
]);

/**
 * Crude proper-noun entities from a question: capitalised words that are NOT
 * sentence-initial (the first word of every sentence is capitalised by
 * convention, so it carries no signal).
 *
 * Used by the knowledge gate/fallback to stop a "visa for Japan" question from
 * being grounded on an India entry just because the topic words match.
 */
export function entityTokens(text: string): string[] {
  const out: string[] = [];
  // Split into sentences so only mid-sentence capitals count as entities.
  const sentences = text.split(/(?:^|[.!?;:\n])\s*/).filter(Boolean);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      const bare = words[i]
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9]/g, "");
      if (bare.length < 2 || !/^[A-Z]/.test(words[i])) continue;
      const key = bare.toLowerCase();
      if (!key || STOP.has(key) || QUESTION_WORDS.has(key) || NON_ENTITY.has(key)) continue;
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

/** Unique tokens preserving first-seen order. */
export function unique<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Jaccard overlap of two token sets (0..1) — used for near-duplicate detection.
 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Reference document length used to damp the precision term (see
 * `overlapScore`). Real documents are hundreds of tokens long; using their
 * raw size makes precision — and therefore the whole F1 score — collapse to
 * ~0 for every genuinely relevant hit.
 */
const REF_DOC_TOKENS = 24;

/**
 * Token-overlap relevance (0..1) between a query and a document.
 *
 * Harmonic mean of query recall and a length-damped precision. The damping
 * matters: precision measured against the document's *raw* token count would
 * punish long entries ("a 300-word article that answers the question head-on
 * scores below a 5-word fragment that merely repeats it"), which used to push
 * every knowledge/memory doc under `KNOWLEDGE_LEXICAL_MIN` and empty the
 * context block.
 */
export function overlapScore(query: string, doc: string): number {
  const q = queryTokens(query);
  const d = new Set(significantTokens(doc));
  if (q.length === 0 || d.size === 0) return 0;
  let hits = 0;
  for (const t of q) if (d.has(t)) hits++;
  const recall = hits / q.length;
  // Capped at `hits` so precision can never exceed 1 when the query is longer
  // than the reference length.
  const precision = hits / Math.max(hits, Math.min(d.size, REF_DOC_TOKENS));
  const f = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  // Phrase bonus: the whole query (minus punctuation) appearing verbatim.
  const needle = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const phrase = q.length > 1 && needle.length > 8 && doc.toLowerCase().includes(needle) ? 0.15 : 0;
  return Math.min(1, f * 0.85 + phrase);
}

/** Truncate on a word boundary for context building. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}
