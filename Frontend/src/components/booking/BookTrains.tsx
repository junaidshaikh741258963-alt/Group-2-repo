"use client";

import { useState } from "react";
import StationField from "@/components/ui/StationField";
import AddToTripButton from "@/components/ui/AddToTripButton";
import CategoryIcon from "@/components/ui/CategoryIcon";
import type { StationSuggestion, TrainJourney } from "@/lib/trains";
import type { TripItemInput } from "@/lib/tripItems";
import { trainBookingTarget, bookLinkProps } from "@/lib/bookingLinks";
import { clockTime, dayLabel, formatMinutes, isoDateInDays, priceLabel } from "@/lib/bookingFormat";
import { DateField, TimeField } from "@/components/booking/BookingPickers";

function journeyItem(t: TrainJourney): TripItemInput {
  const lines = Array.from(
    new Set(
      t.legs
        .filter((l) => l.kind === "ride")
        .map((l) => l.line)
        .filter(Boolean)
    )
  );
  return {
    name: lines.join(" + ") || "Train",
    category: "train",
    detail: [
      `${clockTime(t.departAt)} → ${clockTime(t.arriveAt)}`,
      formatMinutes(t.durationMin),
      t.transfers === 0 ? "Direct" : `${t.transfers} change${t.transfers > 1 ? "s" : ""}`,
    ]
      .filter(Boolean)
      .join(" · "),
    description: [t.from, t.to].filter(Boolean).join(" → "),
    price: priceLabel(t.price, t.currency),
  };
}

export default function BookTrains() {
  const [from, setFrom] = useState<StationSuggestion | null>(null);
  const [fromText, setFromText] = useState("");
  const [to, setTo] = useState<StationSuggestion | null>(null);
  const [toText, setToText] = useState("");
  const [date, setDate] = useState(() => isoDateInDays(1));
  const [time, setTime] = useState("09:00");

  const [trains, setTrains] = useState<TrainJourney[]>([]);
  const [provider, setProvider] = useState("");
  const [route, setRoute] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const ready = fromText.trim().length > 1 && toText.trim().length > 1 && !searching;

  const handleSearch = async () => {
    if (!ready) {
      setError("Pick a departure and an arrival station first.");
      return;
    }
    setError("");
    setSearching(true);
    setSearched(true);
    setTrains([]);
    setProvider("");
    try {
      const res = await fetch("/api/trains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: from?.id || fromText,
          to: to?.id || toText,
          date,
          time,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(String(data.error || "Couldn't search trains. Try again."));
      } else {
        const list: TrainJourney[] = Array.isArray(data.trains) ? data.trains : [];
        setTrains(list);
        setProvider(typeof data.provider === "string" ? data.provider : "");
        setRoute(typeof data.route === "string" ? data.route : "");
        if (list.length === 0) setError("No trains found for that route and time.");
      }
    } catch {
      setError("Couldn't search trains. Try again.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-hairline bg-zinc-900/70 p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/15 border border-amber-400/25 text-amber-300">
            <CategoryIcon kind="train" className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-md font-semibold text-ink">Search trains</h2>
            <p className="text-sm text-ink-faint">
              Live rail times for India, the UK and Germany — add one to your trip board.
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <StationField
            label="From"
            value={fromText}
            placeholder="Departure station (e.g. New Delhi, Berlin Hbf)"
            onInputChange={(v) => {
              setFromText(v);
              setFrom(null);
            }}
            onSelect={(s) => {
              setFrom(s);
              setFromText(s.name);
            }}
          />
          <StationField
            label="To"
            value={toText}
            placeholder="Arrival station (e.g. Mumbai Central, London Euston)"
            onInputChange={(v) => {
              setToText(v);
              setTo(null);
            }}
            onSelect={(s) => {
              setTo(s);
              setToText(s.name);
            }}
          />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <DateField label="Date" value={date} onChange={setDate} min={isoDateInDays(0)} />
          <TimeField label="Depart after" value={time} onChange={setTime} />
          <div className="hidden md:block" />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSearch}
            disabled={!ready}
            className="inline-flex min-h-touch items-center rounded-lg bg-accent-strong px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-accent active:bg-blue-700 disabled:bg-surface-2 disabled:text-ink-faint disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
          >
            {searching ? "Searching…" : "Search trains"}
          </button>
          <span className="text-xs text-ink-muted">
            {dayLabel(date) || "Pick a date"} at {time}
          </span>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-3 text-sm text-danger bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-3"
          >
            {error}
          </p>
        )}
      </div>

      {searching && (
        <div className="rounded-xl border border-hairline bg-zinc-900/50 px-4 py-8 text-center text-base text-ink-muted">
          <span className="mx-auto mb-3 block h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
          Asking rail operators for connections…
        </div>
      )}

      {!searching && searched && trains.length > 0 && (
        <div className="rounded-xl border border-hairline bg-zinc-900/70 p-4 md:p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink">
              {trains.length} connection{trains.length === 1 ? "" : "s"}
            </h3>
            <span className="text-xs text-ink-faint">
              {[fromText, toText].filter(Boolean).join(" → ")}
              {provider ? ` · ${provider}` : ""}
            </span>
          </div>

          <ul className="space-y-2.5">
            {trains.map((t, i) => {
              const item = journeyItem(t);
              const rides = t.legs.filter((l) => l.kind === "ride");
              const lines = Array.from(new Set(rides.map((l) => l.line).filter(Boolean)));
              const booking = trainBookingTarget(route);
              const bookTitle = `Book ${[t.from, t.to].filter(Boolean).join(" → ") || "this train"} on ${booking.site}`;
              return (
                <li
                  key={`${t.departAt}-${i}`}
                  className="rounded-xl border border-hairline bg-surface-1 px-4 py-4 transition-colors hover:border-amber-500/35 hover:bg-amber-500/[0.05]"
                >
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0">
                          <div className="text-lg font-bold text-ink tabular-nums leading-tight">
                            {clockTime(t.departAt)}
                          </div>
                          <div className="mt-1 max-w-[16ch] truncate text-xs text-ink-muted">
                            {t.from}
                          </div>
                        </div>

                        <div className="min-w-14 flex-1 pt-1 text-center">
                          <div className="text-2xs text-ink-muted">
                            {formatMinutes(t.durationMin)}
                          </div>
                          <div className="my-2 flex items-center gap-1">
                            <span className="h-px flex-1 bg-white/15" />
                            <svg
                              className="w-3.5 h-3.5 text-zinc-600"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M14 5l7 7m0 0l-7 7m7-7H3"
                              />
                            </svg>
                            <span className="h-px flex-1 bg-white/15" />
                          </div>
                          <div className="text-2xs text-ink-muted">
                            {t.transfers === 0
                              ? "Direct"
                              : `${t.transfers} change${t.transfers > 1 ? "s" : ""}`}
                          </div>
                        </div>

                        <div className="min-w-0 text-right">
                          <div className="text-lg font-bold text-ink tabular-nums leading-tight">
                            {clockTime(t.arriveAt)}
                          </div>
                          <div className="mt-1 max-w-[16ch] truncate text-xs text-ink-muted">
                            {t.to}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {lines.map((line, li) => (
                          <span
                            key={`${line}-${li}`}
                            className="rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-200"
                          >
                            {line}
                          </span>
                        ))}
                        {rides[0]?.operator && (
                          <span className="text-xs text-ink-muted">{rides[0].operator}</span>
                        )}
                        <span className="text-xs text-ink-faint">{dayLabel(t.departAt)}</span>
                      </div>
                    </div>

                    <div className="ml-auto flex w-full md:w-auto shrink-0 items-center justify-between md:justify-start gap-3 self-center">
                      <div className="text-right">
                        <div className="text-md font-bold leading-none text-emerald-300">
                          {priceLabel(t.price, t.currency) ?? "—"}
                        </div>
                        <div className="mt-1 text-2xs text-ink-muted">
                          {typeof t.price === "number" ? "lowest fare" : "no fare data"}
                        </div>
                      </div>
                      <div className="flex flex-col items-stretch gap-2">
                        <a
                          {...bookLinkProps(booking, bookTitle)}
                          className="inline-flex min-h-touch items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-amber-400/30 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-100 transition-colors hover:border-amber-300 hover:bg-amber-500/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                        >
                          Book on {booking.site}
                          <span aria-hidden>↗</span>
                        </a>
                        <AddToTripButton item={item} theme="dark" />
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="mt-3 text-xs text-zinc-600">
            Times are local to each station. Schedules via Indian Railways, National Rail and HAFAS
            — check with the operator before you travel.
          </p>
        </div>
      )}
    </div>
  );
}
