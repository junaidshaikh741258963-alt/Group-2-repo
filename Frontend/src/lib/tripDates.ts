/**
 * Trip-date parsing shared by the calendar export, the weather join and the
 * booking hand-off. Deliberately small: it understands the shapes people
 * actually type ("March 15-22, 2026", "15-22 March 2026", "2026-03-15",
 * "March 2026") and returns null for anything it would have to guess at.
 */

export interface TripStart {
  /** YYYY-MM-DD */
  iso: string;
  /** True when only month+year were known and day 1 was assumed. */
  approximate: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
const clampDay = (y: number, m: number, d: number) => Math.min(Math.max(1, d), daysInMonth(y, m));

/**
 * Parse the start date of a trip from free text. `now` is injectable so the
 * "no year given → next occurrence" rule is testable.
 */
export function parseTripStart(dates?: string | null, now: Date = new Date()): TripStart | null {
  const s = (dates ?? "").trim();
  if (!s) return null;

  // ISO first: 2026-03-15
  const isoMatch = s.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return { iso: iso(y.length ? +y : 2000, +m, clampDay(+y, +m, +d)), approximate: false };
  }

  // D/M or D-M + month name: "15-22 March 2026", "15 March 2026"
  const dayFirst = s.match(/\b(\d{1,2})(?:\s*(?:-|–|to)\s*\d{1,2})?\s+([A-Za-z]{3,9})\.?\s*,?\s*(20\d{2})?/);
  if (dayFirst && MONTHS[dayFirst[2].toLowerCase()] !== undefined) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const year = dayFirst[3] ? +dayFirst[3] : rollYear(month, now);
    return { iso: iso(year, month, clampDay(year, month, +dayFirst[1])), approximate: false };
  }

  // Month name first: "March 15-22, 2026" / "March 15, 2026" / "March 2026"
  const monthFirst = s.match(
    /\b([A-Za-z]{3,9})\.?\s*(?:(\d{1,2})(?!\d)(?:\s*(?:-|–|to)\s*\d{1,2})?)?\s*,?\s*(20\d{2})?/
  );
  if (monthFirst && MONTHS[monthFirst[1].toLowerCase()] !== undefined) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const year = monthFirst[3] ? +monthFirst[3] : rollYear(month, now);
    if (monthFirst[2]) {
      return { iso: iso(year, month, clampDay(year, month, +monthFirst[2])), approximate: false };
    }
    return { iso: iso(year, month, 1), approximate: true };
  }

  // "In June" style single month in a sentence ("sometime in June 2026")
  const bare = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
  if (bare && MONTHS[bare[1].toLowerCase()] !== undefined) {
    const month = MONTHS[bare[1].toLowerCase()];
    const yearMatch = s.match(/(20\d{2})/);
    const year = yearMatch ? +yearMatch[1] : rollYear(month, now);
    return { iso: iso(year, month, 1), approximate: true };
  }

  return null;
}

/** Year omitted → the next occurrence of that month (this year if still ahead). */
function rollYear(month: number, now: Date): number {
  const y = now.getFullYear();
  return month < now.getMonth() + 1 ? y + 1 : y;
}

/** Add days to a YYYY-MM-DD string (UTC-safe, no DST surprises). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Date for itinerary day N (day 1 = start). */
export function dateForDay(startIso: string, day: number): string {
  return addDays(startIso, Math.max(0, day - 1));
}

/** "2026-03-15" → "Sun, Mar 15" for chips. */
export function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
