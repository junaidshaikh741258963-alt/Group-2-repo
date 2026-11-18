/**
 * Day scheduler (Phase 4) — turns a list of stops into a realistic day plan.
 *
 * Deterministic and pure so it is unit-tested and cheap to run on every
 * render: sequential scheduling inside a 09:00–20:00 window with
 *   · travel time between stops (haversine; walk ≤1.2 km, else transit),
 *   · lunch/dinner breaks once the day is long enough,
 *   · opening-hour respect ("09:00-17:00" — best-effort, others ignored),
 *   · an "overpacked" verdict + concrete warning text.
 *
 * Times are minutes-from-midnight integers. No Date, no timezone surprises.
 */

export const DAY_WINDOW = { start: 9 * 60, end: 20 * 60 } as const;

/** How the traveller moves between stops. "smart" keeps the historical
 *  mix (walk short hops, transit the rest); explicit modes let the UI offer
 *  walk / transit / drive and show the resulting day. */
export type TravelMode = "walk" | "transit" | "drive";
export type TravelModeChoice = TravelMode | "smart";

export interface ScheduleStopInput {
  id: string;
  name: string;
  /** Minutes on site (typical). Resolved upstream by durations.ts. */
  minutes: number;
  lat?: number;
  lng?: number;
  /** "09:00-17:00" — unsupported formats are ignored, never guessed. */
  openingHours?: string;
  /** Free-text category ("museum", "restaurant", "park") — used by the
   *  weather-swap and budget logic, never for timing. */
  category?: string;
}

export interface ScheduledStop {
  kind: "stop" | "break";
  id: string;
  name: string;
  start: number;
  end: number;
  minutes: number;
  /** Travel from the previous entry (0 for the first entry of the day). */
  travelMinutes: number;
  /** Aerial distance of the leg that precedes this stop, km (0 when unknown). */
  travelKm: number;
  /** Notes: "Opens 10:00", "Closes 17:00 — check it fits". */
  flags: string[];
}

export interface DayPlan {
  stops: ScheduledStop[];
  visitMinutes: number;
  travelMinutes: number;
  /** Total aerial distance walked/moved between consecutive stops, km. */
  travelKm: number;
  breakMinutes: number;
  /** Nothing planned between end of last entry and the end of the window. */
  freeMinutes: number;
  end: number;
  overpacked: boolean;
  warnings: string[];
  /** Mode the plan was scheduled with (echoed for the UI footer). */
  travelMode: TravelModeChoice;
}

export interface ScheduleOptions {
  start?: number;
  end?: number;
  /** First entry's start override (e.g. the first itinerary item says "10:30"). */
  anchor?: number;
  /** Travel mode for inter-stop legs (default "smart"). */
  travelMode?: TravelModeChoice;
}

export function formatClock(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const EARTH_R = 6371;
/** Great-circle distance in km — enough for city-scale travel estimates. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Round to 5 minutes, never below 3 — the granularity a human plans with. */
const roundLeg = (minutes: number) => Math.max(3, Math.round(minutes / 5) * 5);

/**
 * Stage 1 of travel-mode math: aerial km between two stops (0 when either
 * end has no coordinates).
 */
export function legKm(a?: ScheduleStopInput, b?: ScheduleStopInput): number {
  if (
    !a ||
    !b ||
    a.lat === undefined ||
    a.lng === undefined ||
    b.lat === undefined ||
    b.lng === undefined
  )
    return 0;
  const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
  return km < 0.05 ? 0 : km;
}

/**
 * Stage 2: km → minutes for an explicit mode.
 *   walk     4.5 km/h + 2 min buffer (crossing streets, finding entrances)
 *   transit  18 km/h + 8 min (wait + in-vehicle for a typical city hop)
 *   drive    28 km/h + 6 min (city traffic + parking)
 * These are deliberately conservative estimates, labelled as such in the UI.
 */
export function travelMinutesMode(
  a: ScheduleStopInput | undefined,
  b: ScheduleStopInput | undefined,
  mode: TravelMode
): number {
  const km = legKm(a, b);
  if (km === 0) return 0;
  if (mode === "walk") return roundLeg((km / 4.5) * 60 + 2);
  if (mode === "drive") return roundLeg((km / 28) * 60 + 6);
  return roundLeg((km / 18) * 60 + 8);
}

/** Smart default: walk short hops (4.5 km/h), transit the rest (18 km/h). */
export function travelMinutes(a?: ScheduleStopInput, b?: ScheduleStopInput): number {
  const km = legKm(a, b);
  if (km === 0) return 0;
  const minutes = km <= 1.2 ? (km / 4.5) * 60 + 2 : (km / 18) * 60 + 8;
  return Math.max(3, Math.round(minutes / 5) * 5);
}

/** "09:00-17:00" / "9:00–17:00" → minutes, else null. */
export function parseOpeningHours(raw?: string): { open: number; close: number } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const open = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const close = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  if (close <= open || open < 0 || close > 24 * 60) return null;
  return { open, close };
}

const LUNCH_MINUTES = 60;
const DINNER_MINUTES = 45;

/**
 * Schedule one day. Stops keep their given order; run `reorderByProximity`
 * first if the order should be optimised for walking.
 */
export function scheduleDay(stops: ScheduleStopInput[], opts: ScheduleOptions = {}): DayPlan {
  const dayStart = opts.start ?? DAY_WINDOW.start;
  const dayEnd = opts.end ?? DAY_WINDOW.end;
  const travelMode: TravelModeChoice = opts.travelMode ?? "smart";
  const legMinutes = (from?: ScheduleStopInput, to?: ScheduleStopInput) =>
    travelMode === "smart" ? travelMinutes(from, to) : travelMinutesMode(from, to, travelMode);
  const entries: ScheduledStop[] = [];
  let cursor = Math.max(dayStart, opts.anchor ?? dayStart);
  let lunchTaken = false;
  let prev: ScheduleStopInput | undefined;
  let visitMinutes = 0;
  let travelTotal = 0;
  let travelKmTotal = 0;

  const pushBreak = (kind: string, name: string, minutes: number) => {
    entries.push({
      kind: "break",
      id: `break-${kind}-${entries.length}`,
      name,
      start: cursor,
      end: cursor + minutes,
      minutes,
      travelMinutes: 0,
      travelKm: 0,
      flags: [],
    });
    cursor += minutes;
  };

  for (const stop of stops) {
    if (stop.minutes <= 0) continue;
    // Lunch: once the clock has reached noon and the next stop would start after it.
    if (!lunchTaken && cursor >= 12 * 60) {
      pushBreak("lunch", "Lunch break", LUNCH_MINUTES);
      lunchTaken = true;
    }

    const travelHere = prev ? legMinutes(prev, stop) : 0;
    const kmHere = prev ? legKm(prev, stop) : 0;
    cursor += travelHere;
    travelTotal += travelHere;
    travelKmTotal += kmHere;

    const flags: string[] = [];
    const hours = parseOpeningHours(stop.openingHours);
    if (hours && cursor < hours.open) {
      flags.push(`Opens ${formatClock(hours.open)} — wait until it opens`);
      cursor = hours.open;
    }
    const start = cursor;
    const minutes = Math.round(stop.minutes);
    const end = start + minutes;
    if (hours && end > hours.close) {
      flags.push(`Closes ${formatClock(hours.close)} — this stop may not fit`);
    }
    // Mid-visit noon: take lunch right after it rather than before a bad split.
    entries.push({
      kind: "stop",
      id: stop.id,
      name: stop.name,
      start,
      end,
      minutes,
      travelMinutes: travelHere,
      travelKm: kmHere,
      flags,
    });
    cursor = end;
    visitMinutes += minutes;
    prev = stop;

    if (!lunchTaken && cursor >= 12 * 60) {
      pushBreak("lunch", "Lunch break", LUNCH_MINUTES);
      lunchTaken = true;
    }
  }

  if (entries.length > 0 && cursor >= 18 * 60 + 30) {
    pushBreak("dinner", "Dinner break", DINNER_MINUTES);
  }

  const end = cursor;
  const breakMinutes = entries.filter((e) => e.kind === "break").reduce((s, e) => s + e.minutes, 0);
  const overpacked = end > dayEnd;
  const warnings: string[] = [];
  if (overpacked) {
    const overflow = end - dayEnd;
    const lastStop = [...entries].reverse().find((e) => e.kind === "stop");
    const overloaded = [...entries]
      .filter((e) => e.kind === "stop")
      .sort((a, b) => b.minutes - a.minutes)[0];
    warnings.push(
      `This day runs ~${formatClock(end)} — ${formatClock(overflow)} past a comfortable ${formatClock(dayEnd)} finish.` +
        (overloaded
          ? ` Consider moving "${overloaded.name}" (${overloaded.minutes} min) to another day.`
          : "")
    );
    if (lastStop && lastStop.flags.length > 0)
      warnings.push(`${lastStop.name}: ${lastStop.flags.join("; ")}.`);
  }
  for (const e of entries) {
    if (e.kind === "stop") {
      for (const flag of e.flags) {
        if (!warnings.some((w) => w.includes(flag))) warnings.push(`${e.name}: ${flag}.`);
      }
    }
  }

  const freeMinutes = Math.max(0, dayEnd - dayStart - visitMinutes - travelTotal - breakMinutes);
  return {
    stops: entries,
    visitMinutes,
    travelMinutes: travelTotal,
    travelKm: travelTotal === 0 ? 0 : travelKmTotal,
    breakMinutes,
    freeMinutes,
    end,
    overpacked,
    warnings,
    travelMode,
  };
}

/**
 * Nearest-neighbour reordering for one day. The first stop stays the anchor
 * (usually the hotel / morning area); stops without coordinates keep their
 * relative position. Returns the original array when there is nothing to win.
 */
export function reorderByProximity(stops: ScheduleStopInput[]): ScheduleStopInput[] {
  const located = stops.filter((s) => s.lat !== undefined && s.lng !== undefined);
  if (stops.length < 3 || located.length < 3) return stops;

  const [anchor, ...rest] = stops;
  if (anchor.lat === undefined || anchor.lng === undefined) return stops;

  const remaining = [...rest];
  const ordered: ScheduleStopInput[] = [anchor];
  let at = anchor;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestKm = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      if (
        s.lat === undefined ||
        s.lng === undefined ||
        at.lat === undefined ||
        at.lng === undefined
      )
        continue;
      const km = haversineKm(at.lat, at.lng, s.lat, s.lng);
      if (km < bestKm) {
        bestKm = km;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    at = next;
  }
  return ordered;
}
