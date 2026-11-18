/** Shared formatting helpers for the flight / train booking sections. */

/** "13:43" from an ISO timestamp or "2026-10-10 13:43" — station-local wall clock. */
export function clockTime(value?: string | null): string {
  if (!value) return "";
  const m = value.match(/(\d{2}:\d{2})(?::\d{2})?/);
  if (m) return m[1];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Fri, Oct 10" from a "YYYY-MM-DD" prefix; empty when there is no date. */
export function dayLabel(value?: string | null): string {
  if (!value) return "";
  const datePart = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return "";
  const d = new Date(`${datePart}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function formatMinutes(min?: number | null): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "$1,240" / "1,240 INR" — never shows a bare number without a currency. */
export function priceLabel(price?: number | null, currency?: string | null): string | undefined {
  if (typeof price !== "number" || !Number.isFinite(price)) return undefined;
  const cur = (currency || "USD").toUpperCase();
  const symbol = cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "GBP" ? "£" : "";
  const amount = Math.round(price).toLocaleString("en-US");
  return symbol ? `${symbol}${amount}` : `${amount} ${cur}`;
}

export function minutesBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

export function isoDateInDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Minutes from clock `a` to clock `b` on the same/next day ("23:10" → "01:05" = 115). */
export function clockDiff(a: string, b: string): number {
  const toMin = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const diff = toMin(b) - toMin(a);
  return diff >= 0 ? diff : diff + 1440;
}

/**
 * "YYYY-MM-DD HH:MM" for an arrival `durationMin` after a local departure clock,
 * rolling into the next day when the journey is overnight.
 */
export function arrivalStamp(date: string, departClock: string, durationMin: number): string {
  const base = Date.parse(`${date}T${departClock}:00Z`);
  if (Number.isNaN(base)) return `${date} ${departClock}`;
  const iso = new Date(base + Math.max(durationMin, 0) * 60000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * "2026-10-10T09:30:00+02:00" for a local wall-clock date+time in `timeZone`
 * (HAFAS expects an explicit offset, and the offset changes with DST).
 */
export function localIsoWithOffset(date: string, time: string, timeZone: string): string {
  const naive = `${date}T${time}:00Z`;
  const asUtc = Date.parse(naive);
  if (Number.isNaN(asUtc)) return `${date}T${time}:00`;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(asUtc));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const shifted = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) % 24,
    Number(get("minute")),
    Number(get("second"))
  );

  const offsetMin = Math.round((shifted - asUtc) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date}T${time}:00${sign}${hh}:${mm}`;
}
