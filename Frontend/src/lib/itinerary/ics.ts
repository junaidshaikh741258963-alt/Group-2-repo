/**
 * Calendar export (.ics) — one VEVENT per itinerary stop, floating local
 * times (no timezone math, which is what every calendar app does with
 * "09:30" anyway). Pure string builder so it is unit-tested; the caller
 * supplies already-scheduled times.
 */

export interface IcsEntry {
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  /** Minutes from midnight, local. */
  start: number;
  end: number;
  summary: string;
  description?: string;
  location?: string;
}

export interface IcsInput {
  /** Calendar name, e.g. "Paris trip". */
  title: string;
  entries: IcsEntry[];
  /** Generation timestamp (defaults to now); injectable for tests. */
  now?: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Escape per RFC 5545: backslash, comma, semicolon, newlines. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold long lines at 75 octets (RFC 5545 3.1). */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  let out = "";
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? 74 : 73;
    // Don't split a surrogate pair.
    let take = limit;
    const code = rest.charCodeAt(Math.min(take, rest.length) - 1);
    if (code >= 0xd800 && code <= 0xdbff) take += 1;
    out += (first ? "" : "\r\n ") + rest.slice(0, take);
    rest = rest.slice(take);
    first = false;
  }
  return out;
}

function stamp(date: string, minutes: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  return `${y}${pad(m)}${pad(d)}T${pad(h)}${pad(min)}00`;
}

function nowStamp(now: Date): string {
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

/** Build the .ics file content. Returns null when there is nothing to export. */
export function buildIcs(input: IcsInput): string | null {
  if (!input.entries.length) return null;
  const now = input.now ?? new Date();
  const seen = nowStamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TripCraft//Itinerary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.title)}`,
  ];

  input.entries.forEach((e, i) => {
    const uid = `${e.date}-${e.start}-${i}@tripcraft.app`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${seen}`,
      `DTSTART:${stamp(e.date, e.start)}`,
      `DTEND:${stamp(e.date, Math.max(e.start + 5, e.end))}`,
      `SUMMARY:${escapeIcsText(e.summary)}`
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Safe file name for the download. */
export function icsFileName(title: string): string {
  const base = title
    .trim()
    .replace(/[^\w\d\s-]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || "trip"}.ics`;
}

/** Trigger a client-side download of an .ics file. */
export function downloadIcs(content: string, fileName: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
