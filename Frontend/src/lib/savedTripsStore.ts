/**
 * Saved trips + share links.
 *
 * A saved trip is a named snapshot of the live itinerary (plus the profile
 * fields that shape it). Everything lives in localStorage so saved trips keep
 * working offline; share links are self-contained (compressed JSON in a URL
 * fragment) and validated on import — a malformed or oversized token is
 * rejected, never partially applied.
 */

import {
  sanitizeLiveItinerary,
  type LiveItinerary,
} from "@/lib/liveItinerary";

export interface SavedTrip {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Snapshot of the plan. */
  itinerary: LiveItinerary;
  /** Whose trip it is, when known (people/budget/pace summary line). */
  travelParty?: string;
}

export const SAVED_TRIPS_KEY = "tripcraft_saved_trips_v1";
const MAX_TRIPS = 40;
const MAX_SHARE_CHARS = 12_000;
const MAX_NAME = 80;

/* ————— persistence ————— */

export function loadSavedTrips(): SavedTrip[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_TRIPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((t) => sanitizeSavedTrip(t))
      .filter((t): t is SavedTrip => t !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function persist(trips: SavedTrip[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAVED_TRIPS_KEY, JSON.stringify(trips.slice(0, MAX_TRIPS)));
  } catch {
    /* quota — the in-memory list still works this session */
  }
}

export function saveTripToStore(
  name: string,
  itinerary: LiveItinerary,
  travelParty?: string,
  id?: string
): SavedTrip {
  const trips = loadSavedTrips();
  const now = Date.now();
  const cleanName = (name.trim() || itinerary.destination || "My trip").slice(0, MAX_NAME);
  const existing = id ? trips.find((t) => t.id === id) : undefined;
  const trip: SavedTrip = existing
    ? { ...existing, name: cleanName, itinerary, travelParty, updatedAt: now }
    : {
        id: id ?? `trip-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        name: cleanName,
        createdAt: now,
        updatedAt: now,
        itinerary,
        travelParty,
      };
  const next = [trip, ...trips.filter((t) => t.id !== trip.id)];
  persist(next);
  return trip;
}

export function duplicateSavedTrip(id: string): SavedTrip | null {
  const trips = loadSavedTrips();
  const src = trips.find((t) => t.id === id);
  if (!src) return null;
  const now = Date.now();
  const copy: SavedTrip = {
    ...src,
    id: `trip-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: `${src.name} (copy)`.slice(0, MAX_NAME),
    createdAt: now,
    updatedAt: now,
    itinerary: { ...src.itinerary, updatedAt: now },
  };
  persist([copy, ...trips]);
  return copy;
}

export function removeSavedTrip(id: string): void {
  persist(loadSavedTrips().filter((t) => t.id !== id));
}

export function renameSavedTrip(id: string, name: string): void {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) return;
  persist(
    loadSavedTrips().map((t) => (t.id === id ? { ...t, name: clean, updatedAt: Date.now() } : t))
  );
}

/** Validate an untrusted object (storage, share import) into a SavedTrip. */
export function sanitizeSavedTrip(raw: unknown): SavedTrip | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const itinerary = sanitizeLiveItinerary(r.itinerary);
  const hasAnyStop = itinerary.days.some((d) => d.stops.length > 0);
  if (!hasAnyStop) return null;
  const id = typeof r.id === "string" && r.id.length >= 4 ? r.id.slice(0, 48) : null;
  if (!id) return null;
  const name =
    typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, MAX_NAME) : "Imported trip";
  const createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
  const travelParty =
    typeof r.travelParty === "string" && r.travelParty.trim()
      ? r.travelParty.trim().slice(0, 80)
      : undefined;
  return { id, name, createdAt, updatedAt, itinerary, travelParty };
}

/* ————— share links ————— */

/**
 * Compact wire shape — short keys keep links small. The plan is re-sanitized
 * on the other side, so this is presentation-only compression.
 */
interface ShareWire {
  v: 1;
  n: string;
  p?: string;
  d?: LiveItinerary["destination"];
  t?: LiveItinerary["dates"];
  c?: number;
  days: Array<{ day: number; title?: string; stops: Array<Record<string, unknown>> }>;
}

function toWire(trip: SavedTrip): ShareWire {
  return {
    v: 1,
    n: trip.name,
    p: trip.travelParty,
    d: trip.itinerary.destination,
    t: trip.itinerary.dates,
    c: trip.itinerary.travelers,
    days: trip.itinerary.days.map((d) => ({
      day: d.day,
      title: d.title,
      stops: d.stops.map((s) => ({
        id: s.id,
        name: s.name,
        minutes: s.minutes,
        lat: s.lat,
        lng: s.lng,
        category: s.category,
        cost: s.cost,
        openingHours: s.openingHours,
      })),
    })),
  };
}

function fromWire(wire: ShareWire): SavedTrip | null {
  if (!wire || wire.v !== 1) return null;
  return sanitizeSavedTrip({
    id: `shared-${Date.now().toString(36)}`,
    name: wire.n,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    travelParty: wire.p,
    itinerary: {
      version: 1,
      destination: wire.d,
      dates: wire.t,
      travelers: wire.c ?? 1,
      updatedAt: Date.now(),
      days: wire.days,
    },
  });
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(token: string): string | null {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeShareToken(trip: SavedTrip): string | null {
  try {
    const token = b64urlEncode(JSON.stringify(toWire(trip)));
    return token.length <= MAX_SHARE_CHARS ? token : null;
  } catch {
    return null;
  }
}

export function decodeShareToken(token: string): SavedTrip | null {
  if (!token || token.length > MAX_SHARE_CHARS) return null;
  const json = b64urlDecode(token.trim());
  if (!json) return null;
  try {
    return fromWire(JSON.parse(json) as ShareWire);
  } catch {
    return null;
  }
}

/** Full shareable URL for the current origin. */
export function shareTripUrl(trip: SavedTrip, origin: string): string | null {
  const token = encodeShareToken(trip);
  if (!token) return null;
  return `${origin.replace(/\/$/, "")}/trips?t=${token}`;
}
