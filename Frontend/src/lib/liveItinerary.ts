/**
 * The live itinerary — one persistent, editable plan per trip.
 *
 * Unlike a chat message (frozen text), this is edited in place by chat
 * commands ("move the Louvre to day 2"), by the planner UI, and re-read by the
 * map. It lives in localStorage so it survives reloads and works offline.
 *
 * Shape is deliberately small: everything derives from stops (duration,
 * coordinates, opening hours, cost), and scheduling is recomputed on render
 * by `lib/itinerary/scheduler`, never stored.
 */

import type { AiReply, ItineraryDay, ItineraryItem } from "@/lib/ai/aiSchema";
import type { Recommendation } from "@/lib/recommendations";
import { categoryDefault, parseDurationText, roundPaceMinutes } from "@/lib/itinerary/durations";
import type { TripProfile } from "@/lib/tripProfile";

export interface LiveStop {
  /** Stable across edits so React keys and map pins survive a move. */
  id: string;
  name: string;
  /** Chat card id when this stop came from a recommendation card. */
  placeId?: string;
  /** Recommendation type or free-text category. */
  category?: string;
  /** Typical visit time in minutes (pace-adjusted). */
  minutes: number;
  lat?: number;
  lng?: number;
  /** "09:00-17:00" when known. */
  openingHours?: string;
  /** Raw cost string ("€15 pp", "Free"). Parsed by the budget module. */
  cost?: string;
  /** User- or model-set start time ("10:30"). */
  time?: string;
  /** Provenance of the recommendation. */
  source?: string;
}

export interface LiveDay {
  day: number;
  title?: string;
  stops: LiveStop[];
}

export interface LiveItinerary {
  version: 1;
  /** Destination this plan belongs to (set from the reply/profile). */
  destination?: string;
  dates?: string;
  /** Traveler count for per-person costs; 1 when unknown. */
  travelers: number;
  /** User pace — durations were tuned with this multiplier. */
  pace?: string | null;
  updatedAt: number;
  days: LiveDay[];
}

export const LIVE_ITINERARY_KEY = "tripcraft_live_itinerary_v1";
const MAX_DAYS = 30;
const MAX_STOPS_PER_DAY = 20;

export function emptyLiveItinerary(): LiveItinerary {
  return { version: 1, travelers: 1, updatedAt: 0, days: [] };
}

export function hasStops(plan: LiveItinerary | null | undefined): boolean {
  return Boolean(plan && plan.days.some((d) => d.stops.length > 0));
}

export function stopCount(plan: LiveItinerary): number {
  return plan.days.reduce((n, d) => n + d.stops.length, 0);
}

/* ————— persistence ————— */

export function loadLiveItinerary(): LiveItinerary {
  if (typeof window === "undefined") return emptyLiveItinerary();
  try {
    const raw = window.localStorage.getItem(LIVE_ITINERARY_KEY);
    if (!raw) return emptyLiveItinerary();
    return sanitizeLiveItinerary(JSON.parse(raw));
  } catch {
    return emptyLiveItinerary();
  }
}

export function saveLiveItinerary(plan: LiveItinerary): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIVE_ITINERARY_KEY, JSON.stringify(plan));
  } catch {
    // Quota — the in-memory copy still works for this session.
  }
}

export function clearLiveItinerary(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LIVE_ITINERARY_KEY);
  } catch {
    /* ignore */
  }
}

/* ————— validation (shared: storage, share links, imports) ————— */

function num(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

/** Coerce untrusted JSON (storage, share link, import) into a valid plan. */
export function sanitizeLiveItinerary(raw: unknown): LiveItinerary {
  const out = emptyLiveItinerary();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  out.destination = str(r.destination, 80);
  out.dates = str(r.dates, 80);
  out.pace = str(r.pace, 20) ?? null;
  out.travelers = Math.round(num(r.travelers, 1, 30) ?? 1);
  out.updatedAt = num(r.updatedAt, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  if (!Array.isArray(r.days)) return out;

  const seenIds = new Set<string>();
  for (const dayRaw of r.days.slice(0, MAX_DAYS)) {
    if (!dayRaw || typeof dayRaw !== "object") continue;
    const d = dayRaw as Record<string, unknown>;
    const dayNo = Math.round(num(d.day, 1, 99) ?? 0);
    if (!dayNo) continue;
    const stops: LiveStop[] = [];
    if (Array.isArray(d.stops)) {
      for (const stopRaw of d.stops.slice(0, MAX_STOPS_PER_DAY)) {
        if (!stopRaw || typeof stopRaw !== "object") continue;
        const s = stopRaw as Record<string, unknown>;
        const name = str(s.name, 120);
        if (!name) continue;
        let id = str(s.id, 40) ?? "";
        if (!id || seenIds.has(id)) id = `s${dayNo}-${stops.length}-${name.slice(0, 8)}`;
        seenIds.add(id);
        stops.push({
          id,
          name,
          placeId: str(s.placeId, 60),
          category: str(s.category, 32),
          minutes: Math.round(num(s.minutes, 5, 720) ?? 60),
          lat: num(s.lat, -90, 90),
          lng: num(s.lng, -180, 180),
          openingHours: str(s.openingHours, 32),
          cost: str(s.cost, 48),
          time: str(s.time, 8),
          source: str(s.source, 60),
        });
      }
    }
    out.days.push({ day: dayNo, title: str(d.title, 90), stops });
  }
  out.days.sort((a, b) => a.day - b.day);
  return out;
}

/* ————— build from a structured reply (the plan on the table) ————— */

function matchPlace(places: Recommendation[], name: string): Recommendation | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    places.find((p) => p.name.trim().toLowerCase() === needle) ??
    places.find((p) => p.name.trim().toLowerCase().startsWith(needle)) ??
    places.find((p) => needle.startsWith(p.name.trim().toLowerCase()))
  );
}

/** Map chat card ids back to a stop, so map focus keeps working after edits. */
function stopFromItem(
  item: ItineraryItem,
  index: number,
  day: number,
  places: Recommendation[],
  pace: string | null | undefined
): LiveStop {
  const match = item.place ? matchPlace(places, item.place) : undefined;
  const rawMinutes =
    match?.visitDuration?.typicalMinutes ??
    parseDurationText(item.duration)?.typicalMinutes ??
    categoryDefault(match?.type ?? item.title).minutes[1];
  return {
    id: `${day}-${index}`,
    name: item.title,
    placeId: match?.id,
    category: match?.type,
    minutes: roundPaceMinutes(rawMinutes, pace),
    lat: match?.lat,
    lng: match?.lng,
    openingHours: match?.openingHours,
    cost: item.cost || match?.price || undefined,
    time: item.time || undefined,
    source: match?.source,
  };
}

/**
 * Turn an assistant itinerary reply into the live plan. `travelers` and
 * `pace` come from the trip profile so budget and duration tuning are right.
 */
export function buildLiveItinerary(
  reply: AiReply,
  places: Recommendation[],
  profile: Pick<TripProfile, "destination" | "dates" | "people" | "pace">
): LiveItinerary {
  const peopleMatch = profile.people?.match(/(\d{1,2})/);
  const travelers = peopleMatch ? Math.min(30, Math.max(1, parseInt(peopleMatch[1], 10))) : 1;
  return {
    version: 1,
    destination: reply.destination || profile.destination || undefined,
    dates: reply.dates || profile.dates || undefined,
    travelers,
    pace: profile.pace ?? null,
    updatedAt: Date.now(),
    days: reply.itinerary.map((day: ItineraryDay) => ({
      day: day.day,
      title: day.title || `Day ${day.day}`,
      stops: day.items.map((item, i) => stopFromItem(item, i, day.day, places, profile.pace)),
    })),
  };
}

/** One-line description for captions and confirmations. */
export function describeItinerary(plan: LiveItinerary): string {
  const n = stopCount(plan);
  const days = plan.days.filter((d) => d.stops.length > 0).length;
  return `${days} ${days === 1 ? "day" : "days"} · ${n} ${n === 1 ? "stop" : "stops"}`;
}
