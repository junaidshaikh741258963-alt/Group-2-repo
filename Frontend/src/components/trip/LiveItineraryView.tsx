"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useLiveItinerary } from "@/components/trip/LiveItineraryContext";
import BudgetCard from "@/components/chat/cards/BudgetCard";
import { computeBudget } from "@/lib/itinerary/budget";
import { formatMinutes } from "@/lib/itinerary/durations";
import {
  DAY_WINDOW,
  formatClock,
  reorderByProximity,
  scheduleDay,
  type ScheduleStopInput,
  type TravelModeChoice,
} from "@/lib/itinerary/scheduler";
import { nextDryDay, suggestIndoorSwaps } from "@/lib/itinerary/weatherSwap";
import { hasStops, stopCount } from "@/lib/liveItinerary";
import { dateForDay, parseTripStart, shortDate } from "@/lib/tripDates";
import {
  weatherEmoji,
  isRainy,
  freshness,
  loadTripWeather,
  type DailyWeather,
  type TripWeather,
} from "@/lib/weather";
import { useCachedFetch } from "@/lib/clientCache";
import { buildIcs, downloadIcs, icsFileName } from "@/lib/itinerary/ics";
import { saveTripToStore, shareTripUrl, type SavedTrip } from "@/lib/savedTripsStore";
import { toast } from "@/lib/toast";

const ChatMiniMap = dynamic(() => import("@/components/chat/cards/ChatMiniMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#eaecef]">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  ),
});

const TRAVEL_MODES: Array<{ id: TravelModeChoice; label: string; title: string }> = [
  { id: "smart", label: "Smart", title: "Walk short hops, transit the rest (default)" },
  { id: "walk", label: "Walk", title: "Only walking between stops" },
  { id: "transit", label: "Transit", title: "Metro/bus between stops" },
  { id: "drive", label: "Drive", title: "Taxi/car between stops" },
];

const btnGhost =
  "inline-flex items-center gap-1 rounded-lg border border-white/[0.12] bg-white/5 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:border-white/[0.2] hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60";

/**
 * The live plan page: every edit made in chat (and here) renders from the one
 * shared LiveItinerary — scheduled times, travel legs, weather swaps, budget
 * and exports all derive on render, never stored.
 */
export default function LiveItineraryView() {
  const { plan, ready, update, applyOps, clear, undo } = useLiveItinerary();
  const [travelMode, setTravelMode] = useState<TravelModeChoice>("smart");
  const router = useRouter();

  const dest = plan.destination ?? "";
  const stops = stopCount(plan);
  const start = useMemo(() => parseTripStart(plan.dates), [plan.dates]);
  const dayNumbers = useMemo(() => plan.days.map((d) => d.day), [plan.days]);

  const dayDates = useMemo(() => {
    const map = new Map<number, string>();
    if (start) for (const d of dayNumbers) map.set(d, dateForDay(start.iso, d));
    return map;
  }, [start, dayNumbers]);

  const weatherQ = useCachedFetch<TripWeather | null>(
    dest ? `weather:${dest}:${Math.max(1, dayNumbers.length || 7)}` : null,
    () =>
      loadTripWeather({
        place: dest,
        days: Math.min(16, Math.max(1, dayNumbers.length || 7)),
      }),
    { ttlMs: 30 * 60_000 }
  );
  const weather = weatherQ.data;
  const weatherByDate = useMemo(() => {
    const map = new Map<string, DailyWeather>();
    if (weather) for (const d of weather.days) map.set(d.date, d);
    return map;
  }, [weather]);

  const scheduled = useMemo(
    () =>
      plan.days.map((day) => {
        const inputs: ScheduleStopInput[] = day.stops.map((s) => ({
          id: s.id,
          name: s.name,
          minutes: s.minutes,
          lat: s.lat,
          lng: s.lng,
          openingHours: s.openingHours,
          category: s.category,
        }));
        return { day, plan: scheduleDay(inputs, { travelMode }) };
      }),
    [plan.days, travelMode]
  );

  const budget = useMemo(() => {
    const entries: Array<{ label: string; category: string; cost: string; day?: number }> = [];
    for (const day of plan.days) {
      for (const s of day.stops) {
        if (!s.cost) continue;
        entries.push({
          label: s.name,
          category: s.category ?? "other",
          cost: s.cost,
          day: day.day,
        });
      }
    }
    if (entries.length === 0) return null;
    return computeBudget(entries, plan.travelers);
  }, [plan.days, plan.travelers]);

  const located = useMemo(() => {
    const out: Array<{ id: string; name: string; lat: number; lng: number }> = [];
    for (const day of plan.days) {
      for (const s of day.stops) {
        if (typeof s.lat === "number" && typeof s.lng === "number") {
          out.push({ id: `${day.day}:${s.id}`, name: s.name, lat: s.lat, lng: s.lng });
        }
      }
    }
    return out;
  }, [plan.days]);

  /** Rain swaps: which outdoor stops sit on wet days, and the next dry day. */
  const swapsByDay = useMemo(() => {
    const map = new Map<
      number,
      Array<{ outdoorId: string; message: string; nextDry: number | null }>
    >();
    if (!weather || weather.days.length === 0) return map;
    for (const day of plan.days) {
      const swaps = suggestIndoorSwaps(day, weatherByDate, dayDates);
      if (swaps.length === 0) continue;
      map.set(
        day.day,
        swaps.map((s) => ({
          outdoorId: s.outdoor.id,
          message: s.message,
          nextDry: nextDryDay(day.day, dayDates, weatherByDate),
        }))
      );
    }
    return map;
  }, [plan.days, weather, weatherByDate, dayDates]);

  const tripName = dest ? `${dest} trip` : "My trip";

  const handleSave = () => {
    const saved = saveTripToStore(
      tripName,
      plan,
      `${plan.travelers} traveler${plan.travelers === 1 ? "" : "s"}${plan.pace ? ` · ${plan.pace}` : ""}`
    );
    toast.success(`Saved “${saved.name}” to your saved trips`, {
      label: "View",
      run: () => {
        router.push("/trips");
      },
    });
  };

  const handleShare = async () => {
    const pseudo: SavedTrip = {
      id: "share",
      name: tripName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      itinerary: plan,
    };
    const url = shareTripUrl(pseudo, window.location.origin);
    if (!url) {
      toast.error("This plan is too large to share as a link — save it instead and export it.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Share link copied — anyone with it can open this plan.");
    } catch {
      window.prompt("Copy this share link:", url);
    }
  };

  const handleExportIcs = () => {
    if (!start) {
      toast.error(
        "Add travel dates in chat first (e.g. “March 15–22, 2026”) to export a calendar file."
      );
      return;
    }
    const entries = scheduled.flatMap(({ day, plan: dp }) =>
      dp.stops
        .filter((s) => s.kind === "stop")
        .map((s) => ({
          date: dateForDay(start.iso, day.day),
          start: s.start,
          end: s.end,
          summary: s.name,
          description: `Day ${day.day}${day.title ? ` · ${day.title}` : ""} — ${formatMinutes(s.minutes)} on site`,
          location: dest || undefined,
        }))
    );
    const ics = buildIcs({ title: tripName, entries });
    if (!ics) {
      toast.error("Nothing to export yet — add stops to the plan.");
      return;
    }
    downloadIcs(ics, icsFileName(tripName));
    toast.success("Calendar file downloaded — import it into Google/Apple Calendar.");
  };

  const handleOptimise = (dayNumber: number) => {
    const day = plan.days.find((d) => d.day === dayNumber);
    if (!day || day.stops.length < 3) return;
    const inputs: ScheduleStopInput[] = day.stops.map((s) => ({
      id: s.id,
      name: s.name,
      minutes: s.minutes,
      lat: s.lat,
      lng: s.lng,
    }));
    const order = reorderByProximity(inputs);
    const byId = new Map(day.stops.map((s) => [s.id, s]));
    const nextStops = order
      .map((i) => byId.get(i.id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    if (nextStops.length !== day.stops.length) return;
    const changed = nextStops.some((s, i) => s.id !== day.stops[i].id);
    if (!changed) {
      toast.info("Already in the shortest route order.");
      return;
    }
    update((cur) => ({
      ...cur,
      days: cur.days.map((d) => (d.day === dayNumber ? { ...d, stops: nextStops } : d)),
    }));
    toast.success(`Optimised day ${dayNumber} for the shortest route.`);
  };

  const handleRemoveStop = (dayNumber: number, stopId: string) => {
    const day = plan.days.find((d) => d.day === dayNumber);
    const stop = day?.stops.find((s) => s.id === stopId);
    if (!stop) return;
    update((cur) => ({
      ...cur,
      days: cur.days.map((d) =>
        d.day === dayNumber ? { ...d, stops: d.stops.filter((s) => s.id !== stopId) } : d
      ),
    }));
    toast.success(`Removed ${stop.name}`, {
      label: "Undo",
      run: () => {
        undo();
      },
    });
  };

  const handleMoveToDryDay = (stopName: string, fromDay: number, toDay: number) => {
    const result = applyOps([{ kind: "move", name: stopName, toDay }]);
    if (result.errors.length > 0) {
      toast.error(result.errors.join(" · "));
    }
  };

  if (!ready) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="h-28 animate-pulse rounded-2xl border border-white/10 bg-surface-1" />
        <div className="h-64 animate-pulse rounded-2xl border border-white/10 bg-surface-1" />
      </div>
    );
  }

  if (!hasStops(plan)) {
    return (
      <div className="rounded-2xl border border-white/10 bg-surface-1 px-6 py-12 text-center">
        <p className="text-3xl" aria-hidden>
          🧭
        </p>
        <h2 className="mt-3 text-lg font-semibold text-ink">No live plan yet</h2>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-muted">
          Build a trip in chat — itinerary replies appear here as a live, editable plan with opening
          hours, travel times, weather and budget. Anything you save by hand waits in the{" "}
          <span className="text-ink-muted">Board</span> tab until the plan is built.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/chat"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Plan a trip in chat
          </Link>
          <Link href="/trips" className={btnGhost}>
            Your saved trips
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ————— Header ————— */}
      <section className="rounded-2xl border border-white/10 bg-surface-1 px-4 py-4 md:px-4">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-52">
            <h2 className="truncate text-xl font-semibold text-ink">
              {dest || "Your trip"}
              {plan.dates ? (
                <span className="font-normal text-ink-muted"> · {plan.dates}</span>
              ) : null}
            </h2>
            <p className="mt-1 text-xs text-ink-muted tabular-nums">
              {plan.days.length} {plan.days.length === 1 ? "day" : "days"} · {stops}{" "}
              {stops === 1 ? "stop" : "stops"} · {plan.travelers}{" "}
              {plan.travelers === 1 ? "traveler" : "travelers"}
              {plan.pace ? ` · ${plan.pace} pace` : ""}
              {weather ? ` · ${freshness(weather.fetchedAt)}` : ""}
            </p>
          </div>

          {/* Travel mode */}
          <div
            role="group"
            aria-label="Travel mode"
            className="inline-flex shrink-0 rounded-xl border border-white/10 bg-zinc-950/50 p-1"
          >
            {TRAVEL_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.title}
                aria-pressed={travelMode === m.id}
                onClick={() => setTravelMode(m.id)}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                  travelMode === m.id
                    ? "bg-accent/20 text-blue-200"
                    : "text-ink-muted hover:bg-white/5 hover:text-ink"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={handleSave} className={btnGhost}>
            💾 Save trip
          </button>
          <button type="button" onClick={handleShare} className={btnGhost}>
            🔗 Share link
          </button>
          <button type="button" onClick={handleExportIcs} className={btnGhost}>
            📅 Calendar (.ics)
          </button>
          <button type="button" onClick={() => window.print()} className={btnGhost}>
            🖨️ PDF
          </button>
          <button
            type="button"
            onClick={() => {
              clear();
              toast.success("Cleared the live plan", {
                label: "Undo",
                run: () => {
                  undo();
                },
              });
            }}
            className="ml-auto inline-flex items-center rounded-lg px-3 py-2 text-xs font-medium text-ink-faint transition-colors hover:bg-white/5 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Clear plan
          </button>
        </div>
      </section>

      {/* ————— Route overview ————— */}
      {located.length > 1 && (
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-surface-1">
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
            <h2 className="text-sm font-semibold text-ink">Route overview</h2>
            <span className="text-2xs text-ink-faint">
              {located.length} located stops · {travelMode === "smart" ? "smart" : travelMode} legs
            </span>
          </div>
          <div className="h-56 w-full">
            <ChatMiniMap
              places={located.map((p) => ({ ...p, name: p.name }))}
              onSelect={(id) => {
                document
                  .querySelector(`[data-live-stop="${CSS.escape(id)}"]`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          </div>
        </section>
      )}

      {/* ————— Days ————— */}
      {scheduled.map(({ day, plan: dp }) => {
        const date = dayDates.get(day.day);
        const wx = date ? weatherByDate.get(date) : undefined;
        const swaps = swapsByDay.get(day.day) ?? [];
        return (
          <section
            key={day.day}
            className="overflow-hidden rounded-2xl border border-white/10 bg-surface-1"
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 bg-surface-1 px-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-3 max-md:basis-full">
                <span className="grid h-6 min-w-6 place-items-center rounded-md bg-accent/15 px-2 text-2xs font-semibold leading-6 text-blue-300 ring-1 ring-inset ring-blue-400/25 tabular-nums">
                  {day.day}
                </span>
                <h2 className="min-w-0 flex-1 truncate text-base font-medium text-ink">
                  {day.title || `Day ${day.day}`}
                </h2>
              </div>
              {date && (
                <span className="text-xs text-ink-faint tabular-nums">{shortDate(date)}</span>
              )}
              {wx && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-2xs font-medium ${
                    isRainy(wx)
                      ? "border-blue-400/35 bg-blue-500/10 text-blue-200"
                      : "border-white/10 bg-white/5 text-ink-muted"
                  }`}
                  title={wx.label}
                >
                  <span aria-hidden>{weatherEmoji(wx.code)}</span>
                  {wx.tempMaxC}°/{wx.tempMinC}°
                  {isRainy(wx)
                    ? ` · ${wx.precipProb != null ? `${wx.precipProb}%` : `${wx.precipMm} mm`}`
                    : ""}
                </span>
              )}
              {day.stops.length > 2 && (
                <button
                  type="button"
                  onClick={() => handleOptimise(day.day)}
                  className="rounded-lg border border-white/[0.12] bg-white/5 px-2 py-1 text-2xs font-semibold text-zinc-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  title="Reorder stops into the shortest route"
                >
                  ⚡ Optimise route
                </button>
              )}
            </header>

            {swaps.length > 0 && (
              <div className="border-b border-white/10 bg-blue-500/5 px-4 py-2">
                {swaps.map((s) => (
                  <p
                    key={s.outdoorId}
                    className="flex flex-wrap items-center gap-2 text-xs text-ink-muted"
                  >
                    <span aria-hidden>☔</span>
                    <span className="min-w-0 flex-1">{s.message}</span>
                    {s.nextDry !== null && (
                      <button
                        type="button"
                        onClick={() => {
                          const outdoor = plan.days
                            .find((d) => d.day === day.day)
                            ?.stops.find((st) => st.id === s.outdoorId);
                          if (outdoor) handleMoveToDryDay(outdoor.name, day.day, s.nextDry!);
                        }}
                        className="shrink-0 rounded-lg border border-blue-400/30 bg-blue-500/15 px-2 py-1 text-2xs font-semibold text-blue-200 transition-colors hover:bg-blue-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                      >
                        Move to day {s.nextDry} (dry)
                      </button>
                    )}
                  </p>
                ))}
              </div>
            )}

            <ol className="px-4 py-3">
              {dp.stops.map((s) => {
                const live = day.stops.find((st) => st.id === s.id);
                const key = `${day.day}:${s.id}`;
                return (
                  <li
                    key={s.id}
                    className="relative flex gap-3 pb-3 last:pb-0"
                    data-live-stop={key}
                  >
                    <span className="relative flex w-2.5 shrink-0 flex-col items-center pt-1">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          s.kind === "break" ? "bg-zinc-600" : "bg-blue-400 ring-4 ring-blue-500/15"
                        }`}
                        aria-hidden
                      />
                      <span className="mt-2 w-px flex-1 bg-surface-3" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="shrink-0 text-xs font-medium tabular-nums text-blue-300">
                          {formatClock(s.start)}–{formatClock(s.end)}
                        </span>
                        <span className="min-w-0 text-base font-medium text-ink">{s.name}</span>
                        {s.kind === "stop" && (
                          <span className="text-2xs text-ink-faint">
                            {formatMinutes(s.minutes)}
                          </span>
                        )}
                        {s.travelMinutes > 0 && (
                          <span
                            className="text-2xs text-ink-faint tabular-nums"
                            title="Travel from the previous stop"
                          >
                            ← {s.travelMinutes} min
                            {s.travelKm > 0 ? ` · ${s.travelKm.toFixed(1)} km` : ""}
                          </span>
                        )}
                        {live && (
                          <button
                            type="button"
                            aria-label={`Remove ${s.name}`}
                            onClick={() => handleRemoveStop(day.day, s.id)}
                            className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-white/5 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              className="h-3.5 w-3.5"
                              aria-hidden
                            >
                              <path
                                d="M6 6l12 12M18 6L6 18"
                                stroke="currentColor"
                                strokeWidth={2}
                                strokeLinecap="round"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                      {s.flags.length > 0 && (
                        <p className="mt-1 text-2xs text-warn">{s.flags.join(" · ")}</p>
                      )}
                    </div>
                  </li>
                );
              })}
              {dp.stops.length === 0 && (
                <li className="py-2 text-sm text-ink-faint">
                  Nothing planned yet — ask in chat or move a stop here.
                </li>
              )}
            </ol>

            {dp.stops.length > 0 && (
              <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 px-4 py-2 text-2xs text-ink-faint tabular-nums">
                <span>≈{formatMinutes(dp.visitMinutes)} on site</span>
                {dp.travelMinutes > 0 && <span>~{formatMinutes(dp.travelMinutes)} moving</span>}
                {dp.travelKm > 0 && <span>{dp.travelKm.toFixed(1)} km</span>}
                {dp.breakMinutes > 0 && <span>{formatMinutes(dp.breakMinutes)} breaks</span>}
                {dp.freeMinutes > 0 && <span>{formatMinutes(dp.freeMinutes)} free</span>}
                <span>
                  {formatClock(Math.max(DAY_WINDOW.start, dp.stops[0].start))} →{" "}
                  {formatClock(dp.end)}
                </span>
                {dp.overpacked && (
                  <span
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-warn/30 bg-warn/10 px-1 py-1 font-medium text-warn"
                    title={dp.warnings.join(" ")}
                  >
                    Overpacked day
                  </span>
                )}
              </footer>
            )}
          </section>
        );
      })}

      {/* ————— Budget ————— */}
      {budget && <BudgetCard summary={budget} travelers={plan.travelers} />}
    </div>
  );
}
