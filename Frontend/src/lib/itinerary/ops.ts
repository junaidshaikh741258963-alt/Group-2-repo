/**
 * Live itinerary edit commands ("move the Louvre to day 2").
 *
 * Deterministic, pure and conservative: a sentence only becomes an op when it
 * clearly names an action AND a target. Questions ("should I move…?") are
 * never applied — they go to the assistant as normal. The applier validates
 * every op against the current plan, so a hallucinated place name is reported
 * as an error instead of corrupting the itinerary.
 */

import type { LiveItinerary, LiveStop } from "@/lib/liveItinerary";

export type ItineraryOp =
  | { kind: "move"; name: string; toDay: number }
  | { kind: "remove"; name: string }
  | { kind: "add"; name: string; toDay: number }
  | { kind: "swap-days"; a: number; b: number }
  | { kind: "clear" };

export interface ApplyContext {
  /** Fallback data for "add X" when X is not in the plan yet. */
  lookup?: (name: string) => Partial<LiveStop> | undefined;
  /** Default visit minutes for newly added stops. */
  defaultMinutes?: number;
}

export interface ApplyResult {
  plan: LiveItinerary;
  applied: string[];
  errors: string[];
}

const cleanName = (raw: string) =>
  raw
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const MIN_NAME = 2;
const MAX_NAME = 80;

/** Doesn't look like a command at all (question, too long, empty). */
function rejectable(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 240) return true;
  if (t.includes("?")) return true;
  return false;
}

/**
 * Parse one user message into zero or more itinerary operations.
 * Multiple ops can appear in one message ("remove X and move Y to day 3").
 */
export function parseItineraryCommand(text: string): ItineraryOp[] {
  if (rejectable(text)) return [];
  const ops: ItineraryOp[] = [];

  const clearRe = /\b(?:clear|reset|start over|scrap|wipe)\b[^.]*\b(itinerary|plan|days?)\b/i;
  if (clearRe.test(text)) {
    return [{ kind: "clear" }];
  }

  const swapRe = /\bswap\b[^.\n]*?\bday\s*(\d{1,2})\b[^.\n]*?\b(?:and|with)\b[^.\n]*?\bday\s*(\d{1,2})\b/i;
  const swap = text.match(swapRe);
  if (swap) {
    const a = parseInt(swap[1], 10);
    const b = parseInt(swap[2], 10);
    if (a !== b && a >= 1 && b >= 1) ops.push({ kind: "swap-days", a, b });
  }

  // remove / delete / drop / take X out (optionally "from day N")
  const removeRe =
    /\b(?:remove|delete|drop|take out)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:from|off)\s+day\s+(\d{1,2}))?\s*(?=[,.!?]|\s+and\s+|\s*$)/gi;
  for (const m of text.matchAll(removeRe)) {
    const name = cleanName(m[1]);
    if (name.length >= MIN_NAME && name.length <= MAX_NAME && !isGeneric(name)) {
      if (!/\b(day|days|stop|stops|everything|all)\b/i.test(name)) {
        ops.push({ kind: "remove", name });
      }
    }
  }

  // move / shift / put X to day N
  const moveRe =
    /\b(?:move|shift|put|place|reschedule)\s+(?:the\s+|my\s+)?([^,.\n?]+?)\s+(?:to|onto|into|on)\s+day\s*(\d{1,2})\b/gi;
  for (const m of text.matchAll(moveRe)) {
    const name = cleanName(m[1]);
    const day = parseInt(m[2], 10);
    if (name.length >= MIN_NAME && name.length <= MAX_NAME && day >= 1 && day <= 60) {
      ops.push({ kind: "move", name, toDay: day });
    }
  }

  // add / include X to day N
  const addRe =
    /\b(?:add|include|append)\s+(?:the\s+|my\s+)?([^,.\n?]+?)\s+(?:to|onto|into|on)\s+day\s*(\d{1,2})\b/gi;
  for (const m of text.matchAll(addRe)) {
    const name = cleanName(m[1]);
    const day = parseInt(m[2], 10);
    if (name.length >= MIN_NAME && name.length <= MAX_NAME && day >= 1 && day <= 60) {
      ops.push({ kind: "add", name, toDay: day });
    }
  }

  return ops;
}

/** Words that would make a false-positive remove op. */
function isGeneric(name: string): boolean {
  return /^(it|that|this|them|those|everything|all|any|something|anything)$/i.test(name);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Find a stop by fuzzy name across all days. Returns day index + stop index. */
export function findStop(
  plan: LiveItinerary,
  name: string
): { dayIdx: number; stopIdx: number; stop: LiveStop } | null {
  const needle = norm(name);
  if (!needle) return null;
  // Exact match first, then "starts with", then "contains" — longest needle wins.
  for (const mode of ["exact", "prefix", "contains"] as const) {
    for (let d = 0; d < plan.days.length; d++) {
      const stops = plan.days[d].stops;
      for (let s = 0; s < stops.length; s++) {
        const hay = norm(stops[s].name);
        const hit =
          mode === "exact" ? hay === needle : mode === "prefix" ? hay.startsWith(needle) : hay.includes(needle);
        if (hit) return { dayIdx: d, stopIdx: s, stop: stops[s] };
      }
    }
  }
  return null;
}

function clone(plan: LiveItinerary): LiveItinerary {
  return {
    ...plan,
    days: plan.days.map((d) => ({ ...d, stops: d.stops.map((s) => ({ ...s })) })),
  };
}

function ensureDay(plan: LiveItinerary, day: number): LiveItinerary {
  if (plan.days.some((d) => d.day === day)) return plan;
  const days = [...plan.days, { day, title: `Day ${day}`, stops: [] }].sort((a, b) => a.day - b.day);
  return { ...plan, days };
}

let seq = 0;
function newStopId(): string {
  seq += 1;
  return `ls${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * Apply ops to a plan. Returns a NEW plan plus human-readable outcome lists —
 * never throws, never partially mutates the input.
 */
export function applyItineraryOps(
  input: LiveItinerary,
  ops: ItineraryOp[],
  ctx: ApplyContext = {}
): ApplyResult {
  let plan = clone(input);
  const applied: string[] = [];
  const errors: string[] = [];

  for (const op of ops) {
    if (op.kind === "clear") {
      plan = { ...plan, days: plan.days.map((d) => ({ ...d, stops: [] })), updatedAt: Date.now() };
      applied.push("Cleared the itinerary");
      continue;
    }

    if (op.kind === "swap-days") {
      const da = plan.days.find((d) => d.day === op.a);
      const db = plan.days.find((d) => d.day === op.b);
      if (!da || !db) {
        errors.push(`Day ${!da ? op.a : op.b} is not in the plan`);
        continue;
      }
      plan = {
        ...plan,
        days: plan.days
          .map((d) =>
            d.day === op.a
              ? { ...d, title: db.title, stops: db.stops }
              : d.day === op.b
                ? { ...d, title: da.title, stops: da.stops }
                : d
          )
          .sort((x, y) => x.day - y.day),
        updatedAt: Date.now(),
      };
      applied.push(`Swapped day ${op.a} and day ${op.b}`);
      continue;
    }

    if (op.kind === "move") {
      const hit = findStop(plan, op.name);
      if (!hit) {
        errors.push(`Couldn't find "${op.name}" in the plan`);
        continue;
      }
      const [moved] = plan.days[hit.dayIdx].stops.splice(hit.stopIdx, 1);
      plan = ensureDay(plan, op.toDay);
      const target = plan.days.find((d) => d.day === op.toDay)!;
      target.stops.push(moved);
      plan = { ...plan, updatedAt: Date.now() };
      applied.push(`Moved "${moved.name}" to day ${op.toDay}`);
      continue;
    }

    if (op.kind === "remove") {
      const hit = findStop(plan, op.name);
      if (!hit) {
        errors.push(`Couldn't find "${op.name}" in the plan`);
        continue;
      }
      const [removed] = plan.days[hit.dayIdx].stops.splice(hit.stopIdx, 1);
      plan = { ...plan, updatedAt: Date.now() };
      applied.push(`Removed "${removed.name}"`);
      continue;
    }

    if (op.kind === "add") {
      const existing = findStop(plan, op.name);
      if (existing) {
        errors.push(`"${existing.stop.name}" is already on day ${plan.days[existing.dayIdx].day}`);
        continue;
      }
      const fallback = ctx.lookup?.(op.name);
      const stop: LiveStop = {
        id: newStopId(),
        name: (fallback?.name ?? cleanName(op.name)).trim().slice(0, 120),
        placeId: fallback?.placeId,
        category: fallback?.category,
        minutes: fallback?.minutes ?? ctx.defaultMinutes ?? 60,
        lat: fallback?.lat,
        lng: fallback?.lng,
        openingHours: fallback?.openingHours,
        cost: fallback?.cost,
        source: fallback?.source,
      };
      plan = ensureDay(plan, op.toDay);
      const target = plan.days.find((d) => d.day === op.toDay)!;
      target.stops.push(stop);
      plan = { ...plan, updatedAt: Date.now() };
      applied.push(`Added "${stop.name}" to day ${op.toDay}`);
    }
  }

  return { plan, applied, errors };
}

/** One-line summary of what a command did — used in the chat + toasts. */
export function describeOps(applied: string[], errors: string[]): string {
  const parts: string[] = [];
  if (applied.length > 0) parts.push(applied.join(" · "));
  if (errors.length > 0) parts.push(errors.join(" · "));
  return parts.join(" — ");
}
