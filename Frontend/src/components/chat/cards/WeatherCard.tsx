"use client";

import { memo } from "react";
import { freshness, isRainy, weatherEmoji, type TripWeather } from "@/lib/weather";
import { shortDate } from "@/lib/tripDates";

interface WeatherCardProps {
  weather: TripWeather;
  /** Maps itinerary day numbers to dates, so chips can say "Day 2 · Sun, Mar 16". */
  dayDates?: Array<{ day: number; date: string }>;
  /** Indoor-swap suggestion when the forecast is wet. */
  swapNote?: string | null;
  /** Cap shown days (default 6). */
  maxDays?: number;
}

/**
 * Per-day forecast for the trip destination — Open-Meteo data with the
 * fetch time printed, rainy days visually flagged, and one short line about
 * indoor options when rain is expected. Never invents a forecast: if the
 * data isn't there, the card isn't rendered by the caller.
 */
function WeatherCard({ weather, dayDates, swapNote, maxDays = 6 }: WeatherCardProps) {
  if (weather.days.length === 0) return null;
  const dayFor = new Map((dayDates ?? []).map((d) => [d.date, d.day]));
  const shown = weather.days.slice(0, maxDays);
  const anyRain = shown.some((d) => isRainy(d));

  return (
    <section
      aria-label={`Weather for ${weather.place}`}
      className="animate-card-in mt-3 overflow-hidden rounded-2xl border border-white/10 bg-surface-2/60"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-base" aria-hidden>
          🌤️
        </span>
        <h4 className="text-sm font-semibold text-ink">Weather · {weather.place}</h4>
        <span className="ml-auto text-2xs text-ink-faint">{freshness(weather.fetchedAt)}</span>
      </div>

      <ul className="flex gap-2 overflow-x-auto px-3 py-3 dark-scroll" role="list">
        {shown.map((day) => {
          const rainy = isRainy(day);
          const dayNo = dayFor.get(day.date);
          return (
            <li
              key={day.date}
              className={`min-w-24 shrink-0 rounded-xl border px-3 py-2 text-center ${
                rainy
                  ? "border-blue-400/35 bg-blue-500/10"
                  : "border-white/10 bg-zinc-950/40"
              }`}
            >
              <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                {dayNo ? `Day ${dayNo}` : shortDate(day.date)}
              </p>
              <p className="mt-1 text-xl leading-none" aria-hidden>
                {weatherEmoji(day.code)}
              </p>
              <p className="mt-1 text-sm font-semibold tabular-nums text-ink">
                {day.tempMaxC}° <span className="font-normal text-ink-muted">{day.tempMinC}°</span>
              </p>
              <p className="mt-1 truncate text-2xs text-ink-muted" title={day.label}>
                {day.label}
              </p>
              {(rainy || (day.precipProb ?? 0) >= 30) && (
                <p className="mt-1 text-2xs font-medium text-blue-300 tabular-nums">
                  {day.precipProb !== undefined ? `${day.precipProb}% rain` : `${day.precipMm} mm`}
                </p>
              )}
              {dayNo && <p className="mt-1 text-2xs text-ink-faint">{shortDate(day.date)}</p>}
            </li>
          );
        })}
      </ul>

      {anyRain && (
        <p className="border-t border-white/10 bg-blue-500/5 px-3 py-2 text-xs leading-relaxed text-ink-muted">
          <span className="font-semibold text-blue-300">Wet day planned? </span>
          {swapNote ??
            "Museums, galleries and covered markets are the good pivots — the itinerary page suggests swaps automatically."}
        </p>
      )}
    </section>
  );
}

export default memo(WeatherCard);
