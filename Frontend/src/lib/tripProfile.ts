import { splitRecommendations, type Recommendation } from "./recommendations";
import { isTravelWindow } from "./ai/travelWindow";

export type ProfileField =
  | "destination"
  | "dates"
  | "people"
  | "budget"
  | "interests"
  | "duration"
  | "accommodation"
  | "hotel"
  | "restaurants"
  | "attractions";

export type PlanningField = ProfileField | "itinerary" | "done";

export interface TripProfile {
  destination: string | null;
  dates: string | null;
  people: string | null;
  budget: string | null;
  interests: string | null;
  duration: string | null;
  accommodation: string | null;
  hotel: string | null;
  restaurants: string | null;
  attractions: string | null;
  itinerary: string | null;
  /** Planning pace: "relaxed" | "packed" (free text); null = balanced default.
   *  Tunes visit durations and how many stops a day gets. */
  pace: string | null;
}

export interface PlanningHint {
  field: PlanningField;
  chips: string[];
}

export const EMPTY_PROFILE: TripProfile = {
  destination: null,
  dates: null,
  people: null,
  budget: null,
  interests: null,
  duration: null,
  accommodation: null,
  hotel: null,
  restaurants: null,
  attractions: null,
  itinerary: null,
  pace: null,
};

/**
 * Stage machine order — one stage per reply:
 * destination → dates → people → budget → interests → hotel → restaurants →
 * attractions → itinerary (only on explicit user request).
 * duration/accommodation remain on the profile for legacy chats but are no longer asked.
 */
export const FIELD_ORDER: ProfileField[] = [
  "destination",
  "dates",
  "people",
  "budget",
  "interests",
  "hotel",
  "restaurants",
  "attractions",
];

const FIELD_LABEL: Record<ProfileField, string> = {
  destination: "Destination",
  dates: "Trip dates",
  people: "Travelers",
  budget: "Budget",
  interests: "Interests",
  duration: "Trip duration",
  accommodation: "Stay type",
  hotel: "Hotel",
  restaurants: "Restaurants",
  attractions: "Activities",
};

const PLANNING_OPEN = "<planning>";
const PLANNING_CLOSE = "</planning>";

export function stripMetaBlocks(content: string): string {
  let text = splitRecommendations(content).text;
  const open = text.indexOf(PLANNING_OPEN);
  if (open !== -1) {
    text = text.slice(0, open);
  }
  return text.replace(/```(?:json)?\s*$/i, "").trimEnd();
}

export function parsePlanning(content: string): PlanningHint | null {
  const open = content.indexOf(PLANNING_OPEN);
  if (open === -1) return null;
  const close = content.indexOf(PLANNING_CLOSE, open);
  if (close === -1) return null;
  const raw = content.slice(open + PLANNING_OPEN.length, close).trim();
  try {
    const data = JSON.parse(raw) as { field?: string; chips?: unknown };
    const field = String(data.field || "").toLowerCase() as PlanningField;
    const valid: PlanningField[] = [
      ...FIELD_ORDER,
      "duration",
      "accommodation",
      "itinerary",
      "done",
    ];
    if (!valid.includes(field)) return null;
    const chips = Array.isArray(data.chips)
      ? data.chips.filter((c): c is string => typeof c === "string").slice(0, 6)
      : [];
    return { field, chips };
  } catch {
    return null;
  }
}

export function missingFields(profile: TripProfile): ProfileField[] {
  return FIELD_ORDER.filter((f) => f !== "destination" && !profile[f]);
}

export function isProfileComplete(profile: TripProfile): boolean {
  return FIELD_ORDER.every((f) => Boolean(profile[f]));
}

/**
 * Stage machine. Returns the next stage to ask about.
 * "itinerary" = profile complete but the user has not explicitly asked for the
 * full plan yet (invite them, do not build it). "done" = itinerary requested.
 */
export function nextField(profile: TripProfile): PlanningField {
  if (!profile.destination) return "destination";
  const missing = FIELD_ORDER.filter((f) => !profile[f]);
  if (missing.length > 0) return missing[0];
  return profile.itinerary ? "done" : "itinerary";
}

export function isReadyForItinerary(profile: TripProfile): boolean {
  return nextField(profile) === "done";
}

export function profileSummary(profile: TripProfile): string {
  const missing = missingFields(profile);
  const lines = FIELD_ORDER.map((f) => `- ${FIELD_LABEL[f]}: ${profile[f] || "unknown"}`);
  if (profile.duration) lines.push(`- Trip duration: ${profile.duration}`);
  if (profile.accommodation) lines.push(`- Stay type: ${profile.accommodation}`);
  if (profile.pace) lines.push(`- Pace: ${profile.pace} (tune durations and daily stop count)`);
  if (profile.itinerary) lines.push("- Itinerary: explicitly requested by the user");
  lines.push(
    `- Missing: ${missing.length ? missing.map((f) => FIELD_LABEL[f]).join(", ") : "none"}`
  );
  const next = nextField(profile);
  if (next === "itinerary") {
    lines.push(
      "- Next: profile complete — invite the user to create the itinerary (do NOT write it yet)"
    );
  } else if (next === "done") {
    lines.push("- Next: itinerary explicitly requested — build the full day-by-day plan");
  } else {
    lines.push(`- Next single field to ask: ${FIELD_LABEL[next]}`);
  }
  return lines.join("\n");
}

export function inferQuestionField(question: string): PlanningField | null {
  const q = question.toLowerCase();
  if (
    /\b(itinerary|day-by-day|full plan|whole trip|build my trip|create my trip|final plan)\b/.test(
      q
    )
  )
    return "itinerary";
  if (/\b(date|dates|when are you|travel dates|which month|what month|depart|return)\b/.test(q))
    return "dates";
  if (
    /\b(people|person|travelers|travellers|adults?|kids?|children|how many|group size|couple|solo)\b/.test(
      q
    )
  )
    return "people";
  if (/\b(budget|cost|price range|how much|spend|expensive|cheap)\b/.test(q)) return "budget";
  if (/\b(interest|into|like to|prefer|vibe|theme|hobby)\b/.test(q)) return "interests";
  if (
    /\b(hotel|hostel|where to stay|accommodation|lodging|resort|airbnb|guesthouse|place to sleep)\b/.test(
      q
    )
  )
    return "hotel";
  if (/\b(restaurants?|where to eat|dining|food spots|meals?)\b/.test(q)) return "restaurants";
  if (/\b(attractions?|things to do|activities|sights|what to see)\b/.test(q)) return "attractions";
  if (/\b(duration|how long|how many days|days?|nights?|weekend|week)\b/.test(q)) return "duration";
  if (
    /\b(accommodation|where to stay|hotel|hostel|airbnb|lodging|stay|resort|guesthouse)\b/.test(q)
  )
    return "hotel";
  if (/\b(destination|where do you want|which city|where to go)\b/.test(q)) return "destination";
  return null;
}

function cleanPlace(raw: string): string {
  const cleaned = raw
    .split(/[.?,!;\n]/)[0]
    .replace(/\s+(?:for|and|with|during|that|this|next|in)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : "";
}

export function extractDestination(...texts: Array<string | null | undefined>): string | null {
  const joined = texts.filter(Boolean).join("\n");
  const patterns = [
    /\b(?:want to|would like to|love to|plan to|plan on|hope to|get to)?\s*(?:visit|visiting|go to|going to|travel to|trip to|vacation (?:in|to)|holiday (?:in|to)|explore)\s+([A-Za-z][A-Za-z\s'-]{1,40})/i,
    /\bhotels?\s+(?:in|near|at|around)\s+([A-Za-z][A-Za-z\s'-]{1,40})/i,
    /\b(?:trip|itinerary|stay)\s+(?:to|in)\s+([A-Za-z][A-Za-z\s'-]{1,40})/i,
    /\bin\s+([A-Z][a-zA-Z\s'-]{2,40})/,
  ];
  for (const p of patterns) {
    const m = joined.match(p);
    if (m?.[1]) {
      const place = cleanPlace(m[1]);
      if (place.length >= 3) return place;
    }
  }
  return null;
}

export function extractDates(text: string): string | null {
  const t = text.trim();
  if (/\b(asap|flexible|not sure|don't know|do not know|whenever|no idea|tbd)\b/i.test(t)) {
    return "Flexible / not decided";
  }
  const range =
    t.match(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}\s*(?:-|–|—|to|through|until)\s*\d{1,2}(?:,\s*\d{2,4})?/i
    ) ||
    t.match(
      /\b\d{1,2}\s*(?:-|–|—|to|through)\s*\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,\s*\d{2,4})?/i
    ) ||
    t.match(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\s*(?:-|–|—|to)\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{2,4})?/i
    );
  if (range) return range[0].replace(/\s+/g, " ").trim();

  const single = t.match(
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,\s*\d{2,4})?/i
  );
  if (single) return single[0].trim();

  const monthYear = t.match(
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?(?:\s+\d{4})?\b/i
  );
  if (monthYear && /\b(trip|travel|visit|go|going|leave|flying|dates?|when)\b/i.test(t)) {
    return monthYear[0].trim();
  }

  if (/\bthis weekend\b/i.test(t)) return "This weekend";
  if (/\bnext weekend\b/i.test(t)) return "Next weekend";
  if (/\bnext month\b/i.test(t)) return "Next month";
  if (/\bnext week\b/i.test(t)) return "Next week";

  const iso = t.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  return null;
}

export function extractPeople(text: string): string | null {
  const t = text.trim();
  if (/\bjust me\b/i.test(t) || /\bsolo\b/i.test(t) || /\balone\b/i.test(t))
    return "Just me (solo)";
  if (/\bcouple\b/i.test(t)) return "Couple (2)";
  const pair = t.match(/\b(\d{1,2})\s*(?:adults?|people|persons?|travelers?|travellers?|pax)\b/i);
  if (pair) return `${pair[1]} travelers`;
  const kids = t.match(/\b(?:family of|we are|with)\s+(\d{1,2})\b/i);
  if (kids) return `Family of ${kids[1]}`;
  const withKids = t.match(/\b(\d{1,2})\s*(?:adults?\s*and\s*)?(\d{1,2})?\s*kids?\b/i);
  if (withKids) return withKids[0].replace(/\s+/g, " ").trim();
  if (/\bfamily\b/i.test(t)) return "Family";
  if (/\bwith kids?\b/i.test(t)) return "Family with kids";
  return null;
}

export function extractDuration(text: string): string | null {
  const t = text.trim();
  const days = t.match(/\b(\d{1,2})\s*(?:-|–|—)?\s*(?:day|days|night|nights)\b/i);
  if (days) return `${days[1]} days`;
  if (/\bweekend\b/i.test(t)) return "Weekend (2 days)";
  if (/\b(?:a|one|1)\s*week\b/i.test(t)) return "7 days";
  if (/\b(?:two|2)\s*weeks?\b/i.test(t)) return "14 days";
  if (/\b(?:three|3)\s*weeks?\b/i.test(t)) return "21 days";
  if (/\b(?:a|one|1)\s*month\b/i.test(t)) return "30 days";
  if (/\bday trip\b/i.test(t)) return "Day trip";
  return null;
}

export function extractBudget(text: string): string | null {
  const t = text.trim();
  if (/\b(flexible|no limit|money is no object|sky is the limit)\b/i.test(t)) return "Flexible";
  const perDay = t.match(/\b\$?\s?(\d{2,5})\s*(?:\/|per|a)\s*day\b/i);
  if (perDay) return `$${perDay[1]}/day`;
  const total = t.match(/\b\$?\s?(\d{3,6})\s*total\b/i);
  if (total) return `$${total[1]} total`;
  const stated = t.match(
    /\b(?:budget|cost|spend(?:ing)?)(?:\s+(?:around|of|about|is|:))?\s*\$?\s?(\d{3,6})\b/i
  );
  if (stated) return `$${stated[1]} total`;
  if (/\bluxur(?:y|ious)\b/i.test(t)) return "Luxury";
  if (/\bboutique|premium|high-end|high end\b/i.test(t)) return "Upscale / boutique";
  if (/\bbudget|cheap|backpack|hostel|save money|affordable\b/i.test(t)) return "Budget";
  if (/\bmid[- ]?range|moderate|comfortable\b/i.test(t)) return "Mid-range";
  const band = t.match(/\b(low|high|medium)\s*budget\b/i);
  if (band) return `${band[1][0].toUpperCase()}${band[1].slice(1)} budget`;
  return null;
}

export function extractInterests(text: string): string | null {
  const t = text.toLowerCase();
  const catalog: Array<[RegExp, string]> = [
    [/\b(food|foodie|cuisine|culinary|eating|restaurants?)\b/, "Food & cuisine"],
    [/\b(culture|history|museums?|art|heritage)\b/, "Culture & history"],
    [/\b(nature|hiking|trekking|mountains?|outdoors?|scenery)\b/, "Nature & outdoors"],
    [/\b(beach|beaches|island|coast|snorkel|surf)\b/, "Beaches & islands"],
    [/\b(nightlife|bars?|clubs?|party|pubs?)\b/, "Nightlife"],
    [/\b(shopping|markets?|boutiques)\b/, "Shopping"],
    [/\b(adventure|sports?|skiing|diving|kayak)\b/, "Adventure"],
    [/\b(family|kids?|children|theme parks?)\b/, "Family-friendly"],
    [/\b(romance|romantic|honeymoon)\b/, "Romance"],
    [/\b(photography|instagram|scenic)\b/, "Photography spots"],
    [/\b(relax|wellness|spa|slow travel)\b/, "Relaxation & wellness"],
    [/\b(night market|street food|local life)\b/, "Local street culture"],
  ];
  const hits = catalog.filter(([re]) => re.test(t)).map(([, label]) => label);
  if (hits.length) return hits.slice(0, 4).join(", ");
  if (/\banything|open|no preference|surprise me|whatever\b/i.test(t)) return "Open to anything";
  return null;
}

export function extractAccommodation(text: string): string | null {
  const t = text.trim();
  if (/\bhostels?\b/i.test(t)) return "Hostels";
  if (/\bairbnb|vacation rental|apartment\b/i.test(t)) return "Airbnb / apartments";
  if (/\bboutique\b/i.test(t)) return "Boutique hotels";
  if (/\bresorts?\b/i.test(t)) return "Resorts";
  if (/\bguest ?houses?\b/i.test(t)) return "Guesthouses";
  if (/\bryokan\b/i.test(t)) return "Ryokans";
  if (/\bhomestay\b/i.test(t)) return "Homestays";
  if (/\bhotels?\b/i.test(t)) return "Hotels";
  if (/\bluxury\b/i.test(t)) return "Luxury hotels";
  if (/\bbudget stay|cheap (?:hotel|place)\b/i.test(t)) return "Budget stays";
  if (/\bnot sure|no preference|anything|whatever|flexible\b/i.test(t))
    return "Open to suggestions";
  return null;
}

const SKIP_RE =
  /^\s*(?:i'?m not sure|not sure|idk|i don'?t know|no idea|skip|whatever|any|anything|flexible|surprise me|up to you|you decide|no preference)\s*[.!]?\s*$/i;

/**
 * Personalization: the traveller's pace, detected from natural phrasing.
 * "take it easy" → relaxed; "see as much as possible" → packed.
 */
export function extractPace(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (
    /\b(?:relaxed|slow[\s-]?paced|take it easy|take things easy|chill|leisurely|unhurried|not too (?:packed|busy|rushed)|no rush|easy days)\b/i.test(
      t
    )
  )
    return "relaxed";
  if (
    /\b(?:packed|action[\s-]?packed|see (?:it )?all|as much as possible|maximi[sz]e|busy schedule|jam[\s-]?packed|fit (?:in )?everything|full days)\b/i.test(
      t
    )
  )
    return "packed";
  return null;
}

export function applyUserAnswer(profile: TripProfile, userText: string): TripProfile {
  const next: TripProfile = { ...profile };
  const text = userText.trim();
  if (!text) return next;

  if (
    /\b(itinerary|day[\s-]?by[\s-]?day|full plan|entire trip|whole trip|create my|build my|generate my|make my)\b/i.test(
      text
    )
  ) {
    next.itinerary = "requested";
  }

  if (!next.destination) {
    const dest = extractDestination(text);
    // A question like "Where should I go in October?" is a discovery request,
    // not a destination answer. Without this guard the stage machine files
    // "October" as the city and the next question becomes "who are you
    // travelling with?" instead of answering the shortlist request.
    if (dest && !isTravelWindow(dest)) next.destination = dest;
  } else {
    const destChange = text.match(
      /\b(?:switch to|change (?:destination|city|place) to|actually|instead)\s+(?:to\s+)?([A-Za-z][A-Za-z\s'-]{2,40})/i
    );
    if (destChange?.[1]) {
      const cleaned = cleanPlace(destChange[1]);
      if (cleaned && !isTravelWindow(cleaned)) next.destination = cleaned;
    }
  }

  if (SKIP_RE.test(text)) {
    if (text.toLowerCase().includes("flexible") && !next.dates) {
      next.dates = "Flexible / not decided";
    }
    if (!next.budget && /\bflexible\b/i.test(text)) next.budget = "Flexible";
    if (!next.accommodation && /\b(any|anything|no preference)\b/i.test(text)) {
      next.accommodation = "Open to suggestions";
    }
    return next;
  }

  const fills: Array<[ProfileField, string | null]> = [
    ["dates", extractDates(text)],
    ["people", extractPeople(text)],
    ["budget", extractBudget(text)],
    ["interests", extractInterests(text)],
    ["duration", extractDuration(text)],
    ["accommodation", extractAccommodation(text)],
  ];

  for (const [field, value] of fills) {
    if (value) next[field] = value;
  }

  const pace = extractPace(text);
  if (pace) next.pace = pace;
  return next;
}

const STAGE_DEFAULTS = new Set(["Open to suggestions", "Flexible"]);

/**
 * Free-form answer for the hotel / restaurants / attractions stages.
 * The whole reply is the answer (a picked name, a style, a chip value);
 * leading conversational verbs are stripped. Skips become sensible defaults.
 */
function stageAnswer(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (SKIP_RE.test(t)) {
    return /\bflexible\b/i.test(t) ? "Flexible" : "Open to suggestions";
  }
  if (t.length > 90 || t.includes("?")) return null;
  const cleaned = t
    .replace(
      /^(?:i'?ll\s+(?:go\s+with|go\s+for|pick|choose|take)\s+|let'?s\s+(?:go\s+with|pick)\s+|go\s+with\s+|choose\s+|pick\s+|book\s+)/i,
      ""
    )
    .replace(/\s*(?:please|thanks|thank you)\b[.!]?$/i, "")
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "");
  return cleaned.length >= 2 ? cleaned.slice(0, 90) : null;
}

function appendList(prev: string | null, value: string): string {
  if (!prev || STAGE_DEFAULTS.has(prev)) return value;
  const parts = prev
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) return prev;
  const merged = [...parts, value].join(", ");
  return merged.length <= 220 ? merged : prev;
}

/**
 * Apply a user reply, targeting the stage the assistant just asked about.
 * For hotel/restaurants/attractions the reply itself becomes the value, so a
 * tapped card ("Hotel New York") or a chip ("Boutique hotel") always lands.
 */
export function applyStageAnswer(
  profile: TripProfile,
  field: PlanningField | null | undefined,
  userText: string
): TripProfile {
  const next = applyUserAnswer(profile, userText);
  if (!field || !userText.trim()) return next;
  const value = stageAnswer(userText);
  if (!value) return next;
  const isDefault = STAGE_DEFAULTS.has(value);
  if (field === "hotel") {
    if (!next.hotel) next.hotel = value;
  } else if (field === "restaurants") {
    if (!(isDefault && next.restaurants)) next.restaurants = appendList(next.restaurants, value);
  } else if (field === "attractions") {
    if (!(isDefault && next.attractions)) next.attractions = appendList(next.attractions, value);
  }
  return next;
}

export function defaultChips(field: PlanningField, profile: TripProfile): string[] {
  switch (field) {
    case "dates":
      return ["This weekend", "Next month", "Flexible dates"];
    case "people":
      return ["Just me", "2 adults", "Family of 4"];
    case "budget":
      return ["Budget", "Mid-range", "Luxury"];
    case "interests":
      return ["Food & culture", "Nature & beaches", "Nightlife", "Family-friendly"];
    case "duration":
      return ["3 days", "5 days", "1 week"];
    case "accommodation":
      return ["Hotels", "Hostels", "Airbnb", "Boutique"];
    case "hotel":
      return ["Boutique hotel", "Luxury stay", "Budget-friendly", "No preference"];
    case "restaurants":
      return ["Local street food", "Fine dining", "Family-friendly", "Surprise me"];
    case "attractions":
      return ["Top landmarks", "Museums & art", "Nature & views", "Hidden gems"];
    case "destination":
      return profile.destination ? [profile.destination] : [];
    case "itinerary":
      return ["Create my itinerary", "Show more restaurants"];
    case "done":
      return ["Build my full itinerary"];
    default:
      return [];
  }
}

export function mergePlanningHint(content: string, profile: TripProfile): PlanningHint | null {
  const parsed = parsePlanning(content);
  if (parsed) {
    const chips =
      parsed.chips.length > 0
        ? parsed.chips
        : parsed.field === "done"
          ? ["Build my full itinerary"]
          : defaultChips(parsed.field, profile);
    return { field: parsed.field, chips };
  }

  const text = stripMetaBlocks(content);
  if (!text.trim()) return null;
  if (!/\?\s*$/.test(text.trim())) {
    if (isProfileComplete(profile) && /\bitinerary|day-by-day|full plan\b/i.test(text)) {
      return profile.itinerary
        ? { field: "done", chips: ["Build my full itinerary"] }
        : { field: "itinerary", chips: defaultChips("itinerary", profile) };
    }
    return null;
  }
  const inferred = inferQuestionField(text);
  if (!inferred || inferred === "destination") return null;
  return { field: inferred, chips: defaultChips(inferred, profile) };
}

export function enrichHotelsPayload(
  profile: TripProfile
): { destination: string; checkIn?: string; checkOut?: string; adults?: number } | null {
  if (!profile.destination) return null;
  const adultsMatch = profile.people?.match(/(\d{1,2})/);
  return {
    destination: profile.destination,
    checkIn: isoFromRange(profile.dates, "in"),
    checkOut: isoFromRange(profile.dates, "out"),
    adults: adultsMatch ? Math.min(12, Math.max(1, parseInt(adultsMatch[1], 10))) : undefined,
  };
}

function isoFromRange(dates: string | null, which: "in" | "out"): string | undefined {
  if (!dates) return undefined;
  const yearMatch = dates.match(/(20\d{2})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
  const months: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  const lower = dates.toLowerCase();
  const monthHits = [
    ...lower.matchAll(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/g
    ),
  ];
  if (monthHits.length === 0) return undefined;
  const mIdx = months[monthHits[0][1]];
  if (mIdx === undefined) return undefined;

  const dayNums = [...lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((d) => d >= 1 && d <= 31);
  let day = 1;
  if (which === "in") {
    day = dayNums[0] ?? 1;
  } else {
    day = dayNums.length >= 2 ? dayNums[1] : (dayNums[0] ?? 1) + 3;
    if (dayNums.length === 1 && monthHits.length >= 1 && dayNums[0] <= 24) day = dayNums[0] + 3;
  }
  const y = monthHits.length >= 2 && mIdx < months[monthHits[1][1]] ? year + 1 : year;
  const d = Math.min(28, Math.max(1, day));
  return `${y}-${String(mIdx + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type { Recommendation };
