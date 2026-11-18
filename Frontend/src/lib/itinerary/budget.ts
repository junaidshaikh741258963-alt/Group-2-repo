/**
 * Budget tracker — deterministic, honest, no invented numbers.
 *
 * Costs only ever come from strings the user can see ("€15 pp", "Free",
 * "$120/night"). Unparseable cost text ("varies") is reported as unparsed
 * rather than guessed at. Mixed currencies are shown per entry; totals are
 * computed only when every parsed entry shares one currency — otherwise the
 * totals block says which currencies are present instead of adding apples to
 * oranges.
 */

export type BudgetCategory = "activities" | "food" | "transport" | "lodging" | "other";

export interface ParsedCost {
  amount: number;
  currency: string;
  /** True when the string said "pp" / "per person". */
  perPerson: boolean;
}

const CURRENCIES: Array<[RegExp, string]> = [
  [/€|eur\b/i, "EUR"],
  [/£|gbp\b/i, "GBP"],
  [/₹|inr\b|rs\.?\b/i, "INR"],
  [/\byen\b|¥|jpy\b/i, "JPY"],
  [/\bchf\b/i, "CHF"],
  [/\baud\b/i, "AUD"],
  [/\bcad\b/i, "CAD"],
  [/\$|usd\b/i, "USD"],
];

/** Symbol for display, given a currency code. */
export function currencySymbol(code: string): string {
  switch (code) {
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "INR":
      return "₹";
    case "JPY":
      return "¥";
    case "CHF":
      return "CHF ";
    case "AUD":
      return "A$";
    case "CAD":
      return "C$";
    default:
      return "$";
  }
}

/**
 * Parse a human cost string. Returns null when there is no number to trust.
 * "Free" is an explicit zero; "varies", "budget", "" are unknown.
 */
export function parseCost(raw?: string | null): ParsedCost | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^free$/i.test(s) || /\bfree\b/i.test(s)) return { amount: 0, currency: detectCurrency(s), perPerson: false };

  const amountMatch = s.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  const amount = Number.parseFloat(amountMatch[1]);
  if (!Number.isFinite(amount)) return null;

  // "10-15" → use the midpoint (typical spend), never the max.
  const range = s.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
  const value = range
    ? (Number.parseFloat(range[1]) + Number.parseFloat(range[2])) / 2
    : amount;

  const perPerson = /\bpp\b|per person|each|p\.p\./i.test(s);
  return { amount: Math.round(value * 100) / 100, currency: detectCurrency(s), perPerson };
}

function detectCurrency(s: string): string {
  for (const [re, code] of CURRENCIES) {
    if (re.test(s)) return code;
  }
  return "USD";
}

/** Map a stop/card category onto a budget bucket. */
export function budgetCategory(category?: string | null): BudgetCategory {
  const c = (category ?? "").toLowerCase();
  if (/restaurant|cafe|bar|food|dining|bakery|bistro|meal|izakaya|trattoria/.test(c)) return "food";
  if (/hotel|hostel|stay|lodging|resort|guesthouse|apartment/.test(c)) return "lodging";
  if (/flight|train|transport|bus|ferry|taxi|metro|transit|car|airport/.test(c)) return "transport";
  if (/museum|attraction|tour|ticket|show|activity|park|gallery|viewpoint/.test(c)) return "activities";
  return "other";
}

export interface BudgetEntry {
  label: string;
  category: BudgetCategory;
  cost: ParsedCost;
  /** Which day it belongs to, when known. */
  day?: number;
}

export interface BudgetDayTotal {
  day: number;
  total: number;
}

export interface BudgetCategoryTotal {
  category: BudgetCategory;
  total: number;
}

export interface BudgetSummary {
  /** Totals currency when uniform; null when mixed currencies block totals. */
  currency: string | null;
  /** All currencies present in parsed entries. */
  currencies: string[];
  /** Trip total for `travelers` people (per-person entries multiplied). */
  total: number;
  perDay: BudgetDayTotal[];
  perCategory: BudgetCategoryTotal[];
  perTraveler: number;
  /** How many entries carried a usable number. */
  countedEntries: number;
  /** Raw cost strings that could not be parsed (shown, never guessed). */
  unparsed: string[];
}

export interface BudgetInput {
  label: string;
  category?: string | null;
  cost?: string | null;
  day?: number;
}

/**
 * Totals for the whole trip. `travelers` multiplies per-person entries.
 * Day totals include only entries with a known day (the itinerary day);
 * parsed entries without a day still count toward trip and category totals.
 */
export function computeBudget(entries: BudgetInput[], travelers = 1): BudgetSummary {
  const people = Math.max(1, Math.round(travelers) || 1);
  const parsed: BudgetEntry[] = [];
  const unparsed: string[] = [];

  for (const e of entries) {
    const cost = parseCost(e.cost);
    if (!cost) {
      if ((e.cost ?? "").trim()) unparsed.push(e.cost!.trim());
      continue;
    }
    parsed.push({ label: e.label, category: budgetCategory(e.category), cost, day: e.day });
  }

  const currencies = [...new Set(parsed.map((p) => p.cost.currency))];
  const currency = currencies.length === 1 ? currencies[0] : currencies.length === 0 ? "USD" : null;

  const entryTotal = (e: BudgetEntry) => e.cost.amount * (e.cost.perPerson ? people : 1);

  const dayMap = new Map<number, number>();
  const catMap = new Map<BudgetCategory, number>();
  let total = 0;
  for (const e of parsed) {
    const t = entryTotal(e);
    total += t;
    if (e.day !== undefined) dayMap.set(e.day, (dayMap.get(e.day) ?? 0) + t);
    catMap.set(e.category, (catMap.get(e.category) ?? 0) + t);
  }

  return {
    currency,
    currencies: currencies.length > 0 ? currencies : ["USD"],
    total: round2(total),
    perDay: [...dayMap.entries()].sort((a, b) => a[0] - b[0]).map(([day, t]) => ({ day, total: round2(t) })),
    perCategory: (["activities", "food", "transport", "lodging", "other"] as BudgetCategory[])
      .filter((c) => catMap.has(c))
      .map((c) => ({ category: c, total: round2(catMap.get(c)!) })),
    perTraveler: round2(total / people),
    countedEntries: parsed.length,
    unparsed: [...new Set(unparsed)].slice(0, 8),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatMoney(amount: number, currency: string | null): string {
  const sym = currencySymbol(currency ?? "USD");
  const rounded = amount >= 100 ? Math.round(amount) : Math.round(amount * 10) / 10;
  const display = rounded.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${sym}${display}${currency ? "" : " (mixed)"}`;
}

export const BUDGET_CATEGORY_LABEL: Record<BudgetCategory, string> = {
  activities: "Activities",
  food: "Food & drink",
  transport: "Transport",
  lodging: "Lodging",
  other: "Other",
};

/** Percentage of total for a category — 0 totals never divide by zero. */
export function categoryShare(total: number, part: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}
