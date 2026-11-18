"use client";

import { memo, useMemo } from "react";
import type { ItineraryDay } from "@/lib/ai/aiSchema";
import type { Recommendation } from "@/lib/recommendations";
import { formatMinutes, parseDurationText } from "@/lib/itinerary/durations";
import { formatClock, scheduleDay, type ScheduleStopInput } from "@/lib/itinerary/scheduler";

interface ItineraryTimelineProps {
  days: ItineraryDay[];
  /** Cards of this message — a stop whose `place` matches one becomes tappable. */
  places?: Recommendation[];
  onFocus?: (id: string) => void;
  onOpenPlace?: (item: Recommendation) => void;
}

/**
 * Run the day through the same scheduler the itinerary builder uses, so the
 * footer ("≈4h on site · ends ~17:00") matches what a real plan would do:
 * durations from the matched card (override > model > text > category),
 * travel between located stops, meal breaks, overpack warnings.
 */
function planDay(day: ItineraryDay, byName: Map<string, Recommendation>) {
  const stops: ScheduleStopInput[] = [];
  let anchor: number | undefined;

  day.items.forEach((item, i) => {
    if (i === 0 && item.time) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(item.time.trim());
      if (m) anchor = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    const match = item.place ? byName.get(item.place.trim().toLowerCase()) : undefined;
    const minutes =
      match?.visitDuration?.typicalMinutes ??
      parseDurationText(item.duration)?.typicalMinutes ??
      60;
    stops.push({
      id: `${day.day}-${i}`,
      name: item.title,
      minutes,
      lat: match?.lat,
      lng: match?.lng,
    });
  });

  return scheduleDay(stops, { anchor });
}

/** Day-by-day plan: one card per day with a vertical timeline inside. */
function ItineraryTimelineInner({
  days,
  places = [],
  onFocus,
  onOpenPlace,
}: ItineraryTimelineProps) {
  const byName = useMemo(() => {
    const map = new Map<string, Recommendation>();
    for (const p of places) map.set(p.name.trim().toLowerCase(), p);
    return map;
  }, [places]);

  if (days.length === 0) return null;

  return (
    <div className="mt-4 space-y-3">
      {days.map((day) => {
        const plan = planDay(day, byName);
        return (
          <section
            key={day.day}
            className="rounded-xl border border-hairline bg-surface-1 overflow-hidden animate-card-in"
          >
            <header className="flex items-center gap-3 px-4 py-3 border-b border-hairline bg-surface-1">
              <span className="grid h-6 min-w-6 place-items-center rounded-md bg-accent/15 px-2 text-2xs font-semibold leading-6 text-blue-300 ring-1 ring-inset ring-blue-400/25 tabular-nums">
                {day.day}
              </span>
              <h4 className="min-w-0 truncate text-base font-medium text-ink">
                {day.title || `Day ${day.day}`}
              </h4>
              <span className="ml-auto shrink-0 text-xs text-ink-faint tabular-nums">
                {day.items.length} {day.items.length === 1 ? "stop" : "stops"}
              </span>
            </header>

            <ol className="px-4 py-3">
              {day.items.map((item, i) => {
                const match = item.place ? byName.get(item.place.trim().toLowerCase()) : undefined;
                const last = i === day.items.length - 1;
                const open = () => {
                  if (!match) return;
                  onFocus?.(match.id);
                  onOpenPlace?.(match);
                };
                return (
                  <li key={`${day.day}-${i}`} className="relative flex gap-3 pb-3 last:pb-0">
                    <span className="relative flex w-2.5 shrink-0 flex-col items-center pt-2">
                      <span
                        className={`h-2 w-2 rounded-full ${match ? "bg-blue-400 ring-4 ring-blue-500/15" : "bg-zinc-600"}`}
                        aria-hidden
                      />
                      {!last && <span className="mt-2 w-px flex-1 bg-surface-3" aria-hidden />}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        {item.time && (
                          <span className="shrink-0 text-xs font-medium tabular-nums text-blue-300">
                            {item.time}
                          </span>
                        )}
                        {match ? (
                          <button
                            type="button"
                            onClick={open}
                            className="min-w-0 truncate text-left text-base font-medium text-ink underline-offset-2 hover:text-blue-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                            title="Show on map"
                          >
                            {item.title}
                          </button>
                        ) : (
                          <span className="min-w-0 text-base font-medium text-ink">
                            {item.title}
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p className="mt-1 text-sm leading-snug text-ink-faint [overflow-wrap:anywhere]">
                          {item.description}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {day.items.length > 0 && (
              <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline px-4 py-2 text-2xs text-ink-faint tabular-nums">
                <span>≈{formatMinutes(plan.visitMinutes)} on site</span>
                {plan.travelMinutes > 0 && <span>~{formatMinutes(plan.travelMinutes)} moving</span>}
                {plan.breakMinutes > 0 && <span>{formatMinutes(plan.breakMinutes)} breaks</span>}
                <span>ends ~{formatClock(plan.end)}</span>
                {plan.overpacked && (
                  <span
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-warn/30 bg-warn/10 px-1 py-1 font-medium text-warn"
                    title={plan.warnings.join(" ")}
                  >
                    Overpacked day
                  </span>
                )}
              </footer>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default memo(ItineraryTimelineInner);
