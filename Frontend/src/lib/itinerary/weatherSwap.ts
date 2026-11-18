/**
 * Rainy-day planning: when a day's forecast is wet, suggest swapping an
 * outdoor stop for an indoor one — instead of silently "optimising" the plan,
 * the swap is a proposal the user can accept in one tap.
 *
 * Everything here is pure so the suggestions are unit-tested.
 */

import type { DailyWeather } from "@/lib/weather";
import { isRainy } from "@/lib/weather";
import type { LiveDay, LiveStop } from "@/lib/liveItinerary";

const OUTDOOR_RE =
  /\b(park|parks|garden|gardens|botanical|beach|esplanade|viewpoint|lookout|plaza|square|piazza|promenade|hike|trail|trek|zoo|market|bridge|waterfront|river|island)\b/i;
const INDOOR_RE =
  /\b(museum|gallery|exhibition|cathedral|church|basilica|mosque|temple|castle|palace|aquarium|spa|theatre|theater|shopping|mall|cafe|restaurant|library|market hall|covered|indoor|underground|tunnel|planetarium)\b/i;

/**
 * Is this stop primarily outdoors (by category, falling back to the name)?
 * An explicit indoor marker wins: "Covered Market" is a market, but you don't
 * get wet in it — the honest classification is indoor.
 */
export function isOutdoorSpot(stop: Pick<LiveStop, "category" | "name">): boolean {
  const text = `${stop.category ?? ""} ${stop.name}`;
  if (INDOOR_RE.test(text)) return false;
  return OUTDOOR_RE.test(text);
}

/** Explicit indoor marker only — never inferred from "not outdoor". */
export function isIndoorSpot(stop: Pick<LiveStop, "category" | "name">): boolean {
  const text = `${stop.category ?? ""} ${stop.name}`;
  return INDOOR_RE.test(text);
}

export interface IndoorSwap {
  /** The outdoor stop to move to a drier day. */
  outdoor: LiveStop;
  /** Indoor stop on the same day that should move up to take its slot. */
  indoor?: LiveStop;
  /** Human sentence for the card/banner. */
  message: string;
}

export interface IndoorAlternative {
  name: string;
  category?: string;
  lat?: number;
  lng?: number;
  minutes?: number;
}

/**
 * Options for a wet day:
 *  1. an indoor stop already on that day → swap the order so the outdoor stop
 *     lands on the next dry day (when one exists);
 *  2. otherwise an indoor alternative from the candidate pool (e.g. museums
 *     from the trip's attractions) → propose adding it and moving the outdoor
 *     stop to the next dry day.
 */
export function suggestIndoorSwaps(
  day: LiveDay,
  weatherByDate: Map<string, DailyWeather>,
  dayDates: Map<number, string>,
  candidates: IndoorAlternative[] = []
): IndoorSwap[] {
  const date = dayDates.get(day.day);
  if (!date) return [];
  const wx = weatherByDate.get(date);
  if (!wx || !isRainy(wx)) return [];

  const swaps: IndoorSwap[] = [];
  const outdoorStops = day.stops.filter((s) => isOutdoorSpot(s));
  const indoorOnDay = day.stops.filter((s) => isIndoorSpot(s));

  for (const outdoor of outdoorStops.slice(0, 2)) {
    const indoor = indoorOnDay.find((s) => s.id !== outdoor.id);
    if (indoor) {
      swaps.push({
        outdoor,
        indoor,
        message: `${wx.label} is forecast on day ${day.day} — start with "${indoor.name}" (indoor) and see "${outdoor.name}" another day.`,
      });
      continue;
    }
    const alt = candidates
      .filter((c) => isIndoorSpot({ name: c.name, category: c.category }))
      .slice(0, 1)[0];
    if (alt) {
      swaps.push({
        outdoor,
        message: `${wx.label} is forecast on day ${day.day} — consider "${alt.name}" instead of "${outdoor.name}" (both are this trip's picks).`,
      });
    } else {
      swaps.push({
        outdoor,
        message: `${wx.label} is forecast on day ${day.day} — "${outdoor.name}" is outdoors. A museum, gallery or market hall would be the better call.`,
      });
    }
  }
  return swaps;
}

/**
 * First day in the plan (with a date map) whose forecast is not rainy —
 * the suggested landing spot for a moved outdoor stop.
 */
export function nextDryDay(
  fromDay: number,
  dayDates: Map<number, string>,
  weatherByDate: Map<string, DailyWeather>
): number | null {
  const entries = [...dayDates.entries()].sort((a, b) => a[0] - b[0]);
  for (const [dayNo, date] of entries) {
    if (dayNo <= fromDay) continue;
    const wx = weatherByDate.get(date);
    if (wx && !isRainy(wx)) return dayNo;
  }
  return null;
}
