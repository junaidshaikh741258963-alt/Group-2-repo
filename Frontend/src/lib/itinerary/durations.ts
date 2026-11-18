/**
 * Visit-duration model (Phase 4).
 *
 * One chain, four sources — first one that has data wins:
 *   user override  >  model estimate  >  text on the card  >  category default
 *
 * Honesty rules: an override is certain (1.0), a model estimate carries the
 * model's own confidence, a parsed "2h" string is half-trusted, and a category
 * default is explicitly labelled rough (0.35). The UI renders confidence as a
 * dot and the basis as a tooltip — never as fake precision.
 */

import { getDurationOverride } from "./durationOverrides";

export interface ResolvedDuration {
  minMinutes: number;
  typicalMinutes: number;
  maxMinutes: number;
  /** 0..1 — how much to trust `typicalMinutes`. */
  confidence: number;
  /** One human line: where the number came from. */
  basis: string;
  origin: "override" | "model" | "text" | "default";
}

/** Key for user overrides — stable across sessions, case/space insensitive. */
export function placeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

type Minutes = [min: number, typical: number, max: number];

/** First pattern wins — order matters ("art museum" → museum, not landmark). */
const CATEGORY_DEFAULTS: Array<{ match: RegExp; minutes: Minutes; label: string }> = [
  { match: /theme ?park|amusement/, minutes: [180, 300, 480], label: "Theme park" },
  { match: /zoo|aquarium/, minutes: [120, 180, 240], label: "Zoo / aquarium" },
  { match: /museum|gallery|exhibition/, minutes: [60, 120, 180], label: "Museum" },
  {
    match: /castle|palace|fort\b|fortress|citadel/,
    minutes: [60, 90, 150],
    label: "Castle / palace",
  },
  {
    match: /temple|shrine|church|cathedral|mosque|synagogue|basilica/,
    minutes: [20, 45, 75],
    label: "Religious site",
  },
  { match: /viewpoint|lookout|observation|tower/, minutes: [15, 30, 60], label: "Viewpoint" },
  { match: /park|garden|botanical/, minutes: [30, 60, 120], label: "Park / garden" },
  { match: /beach/, minutes: [90, 180, 300], label: "Beach" },
  { match: /market|bazaar|souk/, minutes: [30, 75, 120], label: "Market" },
  { match: /hike|trail|trek|climb/, minutes: [90, 180, 360], label: "Hike" },
  { match: /spa\b|onsen|thermal bath/, minutes: [60, 120, 180], label: "Spa / bath" },
  { match: /show|theatre|theater|concert|performance/, minutes: [90, 150, 210], label: "Show" },
  { match: /tour|cruise|boat ride|boat trip|ferry ride/, minutes: [60, 120, 180], label: "Tour" },
  {
    match: /restaurant|dining|bistro|trattoria|izakaya|tavern/,
    minutes: [45, 75, 120],
    label: "Meal",
  },
  { match: /cafe|coffee|bakery|dessert|ice cream/, minutes: [20, 40, 60], label: "Cafe" },
  { match: /bar\b|pub|nightclub|club\b/, minutes: [60, 90, 150], label: "Nightlife" },
  {
    match: /neighbou?rhood|quarter|old town|medina|historic centre|historic center/,
    minutes: [60, 120, 180],
    label: "Neighbourhood walk",
  },
  { match: /square|plaza|piazza/, minutes: [15, 30, 60], label: "Square" },
  { match: /bridge/, minutes: [10, 20, 30], label: "Bridge" },
  { match: /shopping|mall\b|boutique|souvenir/, minutes: [45, 90, 150], label: "Shopping" },
  { match: /landmark|monument|memorial|statue/, minutes: [20, 45, 90], label: "Landmark" },
  { match: /hotel|hostel|resort|lodge|check.?in/, minutes: [15, 30, 60], label: "Hotel stop" },
];

const DEFAULT_MINUTES: Minutes = [30, 60, 120];
const DEFAULT_LABEL = "General stop";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

/** Category default for a free-text category ("art museum", "kuchnia"…). */
export function categoryDefault(category?: string): { minutes: Minutes; label: string } {
  const c = (category ?? "").toLowerCase();
  if (c) {
    for (const entry of CATEGORY_DEFAULTS) {
      if (entry.match.test(c)) return { minutes: entry.minutes, label: entry.label };
    }
  }
  return { minutes: DEFAULT_MINUTES, label: DEFAULT_LABEL };
}

/**
 * Best-effort parse of the loose `duration` string cards carry ("2h", "90 min",
 * "2-3 hours", "half day", "morning"). Returns null when nothing sensible.
 */
export function parseDurationText(
  text?: string | null
): { minMinutes: number; typicalMinutes: number; maxMinutes: number } | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;

  const build = (min: number, typical: number, max: number) => {
    const typ = clamp(round5(typical), 5, 720);
    return {
      minMinutes: clamp(round5(min), 5, typ),
      typicalMinutes: typ,
      maxMinutes: clamp(round5(max), typ, 900),
    };
  };

  const num = (s: string) => Number.parseFloat(s.replace(",", "."));

  const rangeHours = t.match(
    /(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:[.,]\d+)?)\s*(?:h\b|hr|hrs|hour)/
  );
  if (rangeHours) {
    const a = num(rangeHours[1]);
    const b = num(rangeHours[2]);
    if (a > 0 && b >= a) return build(a * 60, ((a + b) / 2) * 60, b * 60);
  }
  const rangeMinutes = t.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)\s*(?:min\b|mins|minutes)/);
  if (rangeMinutes) {
    const a = parseInt(rangeMinutes[1], 10);
    const b = parseInt(rangeMinutes[2], 10);
    if (a > 0 && b >= a) return build(a, (a + b) / 2, b);
  }
  const hours = t.match(/(\d+(?:[.,]\d+)?)\s*(?:h\b|hr|hrs|hour)/);
  if (hours) {
    const x = num(hours[1]);
    if (x > 0) return build(x * 60 * 0.75, x * 60, x * 60 * 1.5);
  }
  const minutes = t.match(/(\d+)\s*(?:min\b|mins|minutes)/);
  if (minutes) {
    const m = parseInt(minutes[1], 10);
    if (m > 0) return build(m * 0.7, m, m * 1.4);
  }
  if (/half[- ]?day/.test(t)) return build(180, 240, 300);
  if (/full[- ]?day|all[- ]?day|whole day/.test(t)) return build(360, 480, 600);
  if (/morning|afternoon/.test(t)) return build(120, 180, 240);
  if (/evening/.test(t)) return build(90, 150, 210);
  return null;
}

export interface DurationInput {
  name?: string;
  category?: string;
  /** The loose string on the card ("2h"). */
  durationText?: string | null;
  /** The model's structured estimate, when it produced one. */
  model?: {
    minMinutes: number;
    typicalMinutes: number;
    maxMinutes: number;
    confidence?: number;
    basis?: string;
  } | null;
  /** Personalization: "relaxed" / "packed" tune the estimate (not the override). */
  pace?: string | null;
}

/** Apply the personal pace to a resolved duration (override stays untouched). */
function withPace(d: ResolvedDuration, pace?: string | null): ResolvedDuration {
  const mult = paceMultiplier(pace);
  if (mult === 1 || d.origin === "override") return d;
  const label = mult > 1 ? "relaxed pace" : "packed pace";
  return {
    minMinutes: round5(d.minMinutes * mult),
    typicalMinutes: round5(d.typicalMinutes * mult),
    maxMinutes: round5(d.maxMinutes * mult),
    confidence: d.confidence,
    basis: `${d.basis} — tuned to your ${label}`,
    origin: d.origin,
  };
}

/** Apply the resolution chain. Always returns a usable duration. */
export function resolveVisitDuration(input: DurationInput): ResolvedDuration {
  const override = input.name ? getDurationOverride(placeKey(input.name)) : null;
  if (override && override >= 5 && override <= 720) {
    return {
      minMinutes: round5(override * 0.75),
      typicalMinutes: round5(override),
      maxMinutes: round5(override * 1.3),
      confidence: 1,
      basis: "Your saved estimate",
      origin: "override",
    };
  }

  if (input.model) {
    const raw = [input.model.minMinutes, input.model.typicalMinutes, input.model.maxMinutes];
    const lo = Math.max(5, Math.min(...raw));
    const hi = Math.min(900, Math.max(...raw));
    const typical = clamp(Math.round(input.model.typicalMinutes), lo, hi);
    return withPace(
      {
        minMinutes: lo,
        typicalMinutes: typical,
        maxMinutes: hi,
        confidence: clamp(input.model.confidence ?? 0.6, 0, 1),
        basis: input.model.basis?.trim() || "Model estimate",
        origin: "model",
      },
      input.pace
    );
  }

  const parsed = parseDurationText(input.durationText);
  if (parsed) {
    return withPace(
      {
        ...parsed,
        confidence: 0.5,
        basis: `Stated on the recommendation ("${(input.durationText ?? "").trim()}")`,
        origin: "text",
      },
      input.pace
    );
  }

  const def = categoryDefault(input.category);
  return withPace(
    {
      minMinutes: def.minutes[0],
      typicalMinutes: def.minutes[1],
      maxMinutes: def.minutes[2],
      confidence: 0.35,
      basis: `${def.label} — typical time on site`,
      origin: "default",
    },
    input.pace
  );
}

/**
 * User pace tuning (personalization). A relaxed traveller spends longer at
 * each stop and wants fewer per day; a packed one moves fast. Applied to the
 * *typical* duration; clamped so a 30-min viewpoint doesn't become 2 hours.
 */
export function paceMultiplier(pace?: string | null): number {
  const p = (pace ?? "").toLowerCase();
  if (/relax|slow|easy|leisur/.test(p)) return 1.25;
  if (/pack|fast|rush|action|maximis|maximiz/.test(p)) return 0.8;
  return 1;
}

export function roundPaceMinutes(minutes: number, pace?: string | null): number {
  const m = minutes * paceMultiplier(pace);
  return clamp(round5(m), 10, 480);
}

/** "2h" / "45 min" / "1.5h" — no tilde, callers add their own. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

export function formatVisitDuration(d: { typicalMinutes: number }): string {
  return formatMinutes(d.typicalMinutes);
}

/** "1.5–3h" / "45–75 min" for tooltips. Short ranges stay in minutes. */
export function formatVisitRange(d: { minMinutes: number; maxMinutes: number }): string {
  if (d.maxMinutes <= 90) return `${Math.round(d.minMinutes)}–${Math.round(d.maxMinutes)} min`;
  const half = (n: number) => Math.round((n / 60) * 2) / 2;
  return `${half(d.minMinutes)}–${half(d.maxMinutes)}h`;
}
