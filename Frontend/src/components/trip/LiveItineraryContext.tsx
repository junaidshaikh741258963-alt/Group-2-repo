"use client";

/**
 * LiveItineraryProvider — the single editable plan the whole app reads.
 *
 * Chat edits ("move the Louvre to day 2"), the planner UI and saved-trip
 * imports all mutate this one document; the map, the itinerary page and the
 * mini-map card re-render from it. Persistence + validation live in
 * `lib/liveItinerary`; this file adds React subscription, undo and toasts.
 *
 * State lives in a module store consumed with useSyncExternalStore so the
 * server renders an empty plan while the client hydrates from localStorage —
 * no hydration mismatch, no set-state-in-effect.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  emptyLiveItinerary,
  loadLiveItinerary,
  saveLiveItinerary,
  buildLiveItinerary,
  describeItinerary,
  type LiveItinerary,
  type LiveStop,
} from "@/lib/liveItinerary";
import { applyItineraryOps, describeOps, type ApplyResult, type ItineraryOp } from "@/lib/itinerary/ops";
import type { AiReply } from "@/lib/ai/aiSchema";
import type { Recommendation } from "@/lib/recommendations";
import type { TripProfile } from "@/lib/tripProfile";
import { toast } from "@/lib/toast";

/* ————— module store ————— */

const EMPTY = emptyLiveItinerary();
let current: LiveItinerary | null = null;
const undoStack: LiveItinerary[] = [];
const MAX_UNDO = 5;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function snapshot(): LiveItinerary {
  if (current === null) current = loadLiveItinerary();
  return current;
}

function serverSnapshot(): LiveItinerary {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: LiveItinerary, options: { undoable?: boolean; persist?: boolean } = {}): void {
  const { undoable = true, persist = true } = options;
  const prev = snapshot();
  if (undoable && prev !== EMPTY) {
    undoStack.push(prev);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }
  current = next;
  if (persist) saveLiveItinerary(next);
  emit();
}

/* ————— public helpers ————— */

/** Case-insensitive lookup of card data for "add X" commands. */
export function lookupFromPlaces(
  places: Recommendation[]
): (name: string) => Partial<LiveStop> | undefined {
  return (name: string) => {
    const needle = name.trim().toLowerCase();
    if (!needle) return undefined;
    const hit =
      places.find((p) => p.name.trim().toLowerCase() === needle) ??
      places.find((p) => p.name.trim().toLowerCase().startsWith(needle)) ??
      places.find((p) => p.name.trim().toLowerCase().includes(needle));
    if (!hit) return undefined;
    return {
      name: hit.name,
      placeId: hit.id,
      category: hit.type,
      minutes: hit.visitDuration?.typicalMinutes ?? 60,
      lat: hit.lat,
      lng: hit.lng,
      openingHours: hit.openingHours,
      cost: hit.price,
      source: hit.source,
    };
  };
}

/** Compact plain-text plan for the chat request (`livePlan` field). */
export function buildLivePlanText(plan: LiveItinerary): string {
  if (!plan.days.some((d) => d.stops.length > 0)) return "";
  const head = [
    plan.destination ? `Destination: ${plan.destination}` : "",
    plan.dates ? `Dates: ${plan.dates}` : "",
    plan.pace ? `Pace: ${plan.pace}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = plan.days
    .filter((d) => d.stops.length > 0)
    .map(
      (d) =>
        `Day ${d.day}${d.title ? ` (${d.title})` : ""}: ` +
        d.stops.map((s) => `${s.name} ~${s.minutes}m${s.time ? ` from ${s.time}` : ""}`).join(" → ")
    );
  return [head, ...lines].join("\n").slice(0, 1400);
}

/* ————— context ————— */

export interface LiveItineraryContextValue {
  plan: LiveItinerary;
  /** True when the provider has real data (vs the SSR empty shell). */
  ready: boolean;
  /** Apply parsed chat ops. Shows a toast (with undo) and returns the outcome. */
  applyOps: (ops: ItineraryOp[], lookup?: (name: string) => Partial<LiveStop> | undefined) => ApplyResult;
  /** Mirror an assistant reply with an itinerary into the live plan. */
  seedFromReply: (
    reply: AiReply,
    places: Recommendation[],
    profile: Pick<TripProfile, "destination" | "dates" | "people" | "pace">
  ) => void;
  /** Arbitrary transformation (planner UI). Not toast-wrapped. */
  update: (updater: (plan: LiveItinerary) => LiveItinerary) => void;
  /** Replace wholesale (saved trip open / share import). */
  replace: (plan: LiveItinerary) => void;
  clear: () => void;
  undo: () => boolean;
  canUndo: boolean;
}

const LiveItineraryContext = createContext<LiveItineraryContextValue | null>(null);

export function LiveItineraryProvider({ children }: { children: ReactNode }) {
  const plan = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const ready = plan !== EMPTY;

  const applyOps = useCallback<LiveItineraryContextValue["applyOps"]>((ops, lookup) => {
    const before = snapshot();
    const result = applyItineraryOps(before, ops, { lookup });
    if (result.applied.length === 0 && result.errors.length === 0) return result;
    if (result.applied.length > 0) {
      commit({ ...result.plan, updatedAt: Date.now() });
      const undo = () => {
        const restored = undoStack.pop();
        if (restored) {
          current = restored;
          saveLiveItinerary(restored);
          emit();
        }
      };
      const message = result.errors.length
        ? `${describeOps(result.applied, result.errors)}`
        : describeOps(result.applied, []);
      toast.success(message, { label: "Undo", run: undo });
    } else if (result.errors.length > 0) {
      toast.error(result.errors.join(" · "));
    }
    return result;
  }, []);

  const seedFromReply = useCallback<LiveItineraryContextValue["seedFromReply"]>(
    (reply, places, profile) => {
      if (reply.itinerary.length === 0) return;
      const next = buildLiveItinerary(reply, places, profile);
      const prev = snapshot();
      const destinationChanged =
        prev.destination &&
        next.destination &&
        prev.destination.trim().toLowerCase() !== next.destination.trim().toLowerCase();
      const empty = !prev.days.some((d) => d.stops.length > 0);
      if (empty || destinationChanged) {
        commit(next, { undoable: false });
      } else {
        // Same trip: replace but keep it undoable so a wrong regeneration is recoverable.
        commit(next);
        toast.info(`Updated the live itinerary — ${describeItinerary(next)}`, {
          label: "Undo",
          run: () => {
            const restored = undoStack.pop();
            if (restored) {
              current = restored;
              saveLiveItinerary(restored);
              emit();
            }
          },
        });
      }
    },
    []
  );

  const update = useCallback<LiveItineraryContextValue["update"]>((updater) => {
    commit({ ...updater(snapshot()), updatedAt: Date.now() });
  }, []);

  const replace = useCallback<LiveItineraryContextValue["replace"]>((next) => {
    commit(next);
  }, []);

  const clear = useCallback(() => {
    commit(emptyLiveItinerary());
  }, []);

  const undo = useCallback(() => {
    const restored = undoStack.pop();
    if (!restored) return false;
    current = restored;
    saveLiveItinerary(restored);
    emit();
    return true;
  }, []);

  const value = useMemo<LiveItineraryContextValue>(
    () => ({
      plan,
      ready,
      applyOps,
      seedFromReply,
      update,
      replace,
      clear,
      undo,
      canUndo: undoStack.length > 0,
    }),
    [plan, ready, applyOps, seedFromReply, update, replace, clear, undo]
  );

  return <LiveItineraryContext.Provider value={value}>{children}</LiveItineraryContext.Provider>;
}

export function useLiveItinerary(): LiveItineraryContextValue {
  const ctx = useContext(LiveItineraryContext);
  if (!ctx) {
    throw new Error("useLiveItinerary must be used inside <LiveItineraryProvider>");
  }
  return ctx;
}
