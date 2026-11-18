"use client";

import { memo, useSyncExternalStore } from "react";
import { formatClock, parseOpeningHours } from "@/lib/itinerary/scheduler";

/**
 * "Open now · closes 18:00" style badge computed from the card's opening
 * hours. A shared minute ticker keeps every badge on the page in sync.
 *
 * SSR renders nothing (the server has no idea what "now" is for the viewer),
 * and the client hydrates into the badge — no mismatch, no flash of a wrong
 * state, because getServerSnapshot returns null on both sides of hydration.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowMinutes: number | null = null;

function currentMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (nowMinutes === null) nowMinutes = currentMinutes();
  if (!timer) {
    timer = setInterval(() => {
      nowMinutes = currentMinutes();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number | null {
  if (nowMinutes === null) nowMinutes = currentMinutes();
  return nowMinutes;
}

function getServerSnapshot(): number | null {
  return null;
}

interface OpenStatusBadgeProps {
  /** "09:00-18:00" — freeform strings that don't parse render nothing. */
  hours?: string | null;
  className?: string;
}

function OpenStatusBadge({ hours, className }: OpenStatusBadgeProps) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const range = parseOpeningHours(hours ?? undefined);
  if (!range || now === null) return null;

  const open = now >= range.open && now < range.close;
  const label = open
    ? `Open · closes ${formatClock(range.close)}`
    : now < range.open
      ? `Opens ${formatClock(range.open)}`
      : `Closed · opens ${formatClock(range.open)}`;
  const tone = open
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : "border-white/12 bg-white/5 text-ink-faint";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-2xs font-medium tabular-nums ${tone}${
        className ? ` ${className}` : ""
      }`}
      title={`Hours today: ${hours}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${open ? "bg-emerald-400" : "bg-zinc-500"}`}
      />
      {label}
    </span>
  );
}

export default memo(OpenStatusBadge);
