"use client";

import { useState } from "react";
import {
  formatMinutes,
  placeKey,
  resolveVisitDuration,
  type ResolvedDuration,
} from "@/lib/itinerary/durations";
import { getDurationOverride, setDurationOverride } from "@/lib/itinerary/durationOverrides";
import DurationBadge from "@/components/ui/DurationBadge";

interface VisitDurationEditorProps {
  /** Place name — the override storage key. */
  name: string;
  /** Category hint for the fallback estimate. */
  category?: string;
  /** The duration the card already resolved; re-resolved only when overridden. */
  fallback?: ResolvedDuration;
}

/** Sensible presets from "quick stop" to "most of a day". */
const PRESETS = [30, 60, 90, 120, 180, 240, 360];

/**
 * "Time on site" — shows the resolved estimate and lets the user override it.
 * Overrides persist per place and win over every other source afterwards.
 */
export default function VisitDurationEditor({ name, category, fallback }: VisitDurationEditorProps) {
  const [override, setOverride] = useState<number | null>(() =>
    getDurationOverride(placeKey(name))
  );

  const resolved =
    override != null
      ? resolveVisitDuration({ name })
      : (fallback ?? resolveVisitDuration({ name, category }));

  const apply = (minutes: number | null) => {
    setDurationOverride(placeKey(name), minutes);
    setOverride(minutes);
  };

  const chip = (active: boolean) =>
    `min-h-touch-sm inline-flex items-center rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
      active
        ? "border-blue-400/45 bg-accent/15 text-blue-200"
        : "border-white/[0.1] bg-surface-1 text-zinc-300 hover:border-white/[0.2] hover:bg-surface-3 hover:text-ink"
    }`;

  return (
    <section aria-label="Time on site">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold tracking-tight text-white">Time on site</h3>
        <DurationBadge duration={resolved} />
        {override != null && (
          <button
            type="button"
            onClick={() => apply(null)}
            className="text-2xs font-medium text-blue-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Reset to estimate
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            aria-pressed={override === minutes}
            onClick={() => apply(minutes)}
            className={chip(override === minutes)}
          >
            {formatMinutes(minutes)}
          </button>
        ))}
      </div>
      <p className="mt-2 text-2xs leading-snug text-ink-faint">{resolved.basis}</p>
    </section>
  );
}
