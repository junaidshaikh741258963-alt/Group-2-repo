"use client";

import { useState } from "react";
import AirportField, {
  suggestionCode,
  suggestionLabel,
  type AirportSuggestion,
} from "@/components/ui/AirportField";
import AddToTripButton from "@/components/ui/AddToTripButton";
import CategoryIcon from "@/components/ui/CategoryIcon";
import type { FlightOffer } from "@/lib/flightOffers";
import type { TripItemInput } from "@/lib/tripItems";
import { flightBookingTarget, bookLinkProps } from "@/lib/bookingLinks";
import { clockTime, dayLabel, formatMinutes, isoDateInDays, priceLabel } from "@/lib/bookingFormat";
import {
  DateField,
  PassengerField,
  passengerSummary,
  type PassengerCounts,
} from "@/components/booking/BookingPickers";

function stopsLabel(stops: number): string {
  return stops === 0 ? "Nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`;
}

function offerItem(o: FlightOffer): TripItemInput {
  const number = o.legs?.[0]?.flightNumber || "";
  const label = [o.airline, number].filter(Boolean).join(" ") || "Flight";
  const route = o.from && o.to ? ` · ${o.from}→${o.to}` : "";
  return {
    name: `${label}${route}`,
    category: "flight",
    detail: [
      `${clockTime(o.departAt)} → ${clockTime(o.arriveAt)}`,
      stopsLabel(o.stops),
      formatMinutes(o.durationMin),
    ]
      .filter(Boolean)
      .join(" · "),
    description: [o.fromName, o.toName].filter(Boolean).join(" → "),
    price: priceLabel(o.price, o.currency),
  };
}

export default function BookFlights() {
  const [from, setFrom] = useState<AirportSuggestion | null>(null);
  const [fromText, setFromText] = useState("");
  const [to, setTo] = useState<AirportSuggestion | null>(null);
  const [toText, setToText] = useState("");
  const [date, setDate] = useState(() => isoDateInDays(14));
  const [returnDate, setReturnDate] = useState("");
  const [pax, setPax] = useState<PassengerCounts>({ adults: 1, children: 0, infants: 0 });

  const [offers, setOffers] = useState<FlightOffer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const canSearch = Boolean(from && to) && !searching;

  const handleSwap = () => {
    const nextFrom = to;
    const nextTo = from;
    const nextFromText = toText;
    const nextToText = fromText;
    setFrom(nextFrom);
    setFromText(nextFromText);
    setTo(nextTo);
    setToText(nextToText);
  };

  const handleSearch = async () => {
    if (!from || !to) {
      setError("Pick both airports from the suggestions first.");
      return;
    }
    setError("");
    setSearching(true);
    setSearched(true);
    setOffers([]);
    try {
      const res = await fetch("/api/flights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departure: suggestionCode(from),
          arrival: suggestionCode(to),
          outboundDate: date,
          ...(returnDate ? { returnDate } : {}),
          adults: pax.adults,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(String(data.error || "Couldn't search flights. Try again."));
      } else {
        const list: FlightOffer[] = Array.isArray(data.flights) ? data.flights : [];
        setOffers(list);
        if (list.length === 0) setError("No flights found for that route.");
      }
    } catch {
      setError("Couldn't search flights. Try again.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-hairline bg-zinc-900/70 p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500/15 border border-sky-400/25 text-sky-300">
            <CategoryIcon kind="flight" className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-md font-semibold text-ink">Search flights</h2>
            <p className="text-sm text-ink-faint">
              Live fares, then add one to your trip board.
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-end">
          <AirportField
            label="From"
            value={fromText}
            placeholder="Departure city or airport (e.g. Paris, JFK)"
            inputClassName="h-12"
            onInputChange={(v) => {
              setFromText(v);
              setFrom(null);
            }}
            onSelect={(s) => {
              setFrom(s);
              setFromText(suggestionLabel(s));
            }}
          />
          <div className="flex items-end justify-center">
            <button
              type="button"
              onClick={handleSwap}
              aria-label="Swap departure and arrival airports"
              title="Swap airports"
              className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-white/10 bg-surface-2 text-ink-muted transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-blue-300 active:bg-accent/20 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
                />
              </svg>
            </button>
          </div>
          <AirportField
            label="To"
            value={toText}
            placeholder="Arrival city or airport (e.g. Tokyo, NRT)"
            inputClassName="h-12"
            onInputChange={(v) => {
              setToText(v);
              setTo(null);
            }}
            onSelect={(s) => {
              setTo(s);
              setToText(suggestionLabel(s));
            }}
          />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
          <DateField label="Departure" value={date} onChange={setDate} min={isoDateInDays(0)} />
          <DateField
            label="Return"
            hint="(optional)"
            value={returnDate}
            onChange={setReturnDate}
            min={date}
            rangeStart={date}
            clearable
            placeholder="Add return"
          />
          <PassengerField value={pax} onChange={setPax} max={9} />
          <button
            type="button"
            onClick={handleSearch}
            disabled={!canSearch}
            className="h-12 rounded-xl bg-accent-strong px-6 text-base font-semibold text-white transition-colors hover:bg-accent disabled:bg-surface-2 disabled:text-ink-faint disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 md:col-span-2 lg:col-span-1"
          >
            {searching ? "Searching…" : "Search flights"}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-xs text-ink-faint">
            {dayLabel(date) || "Pick a date"}
            {returnDate ? ` → ${dayLabel(returnDate)}` : " · one way"}
            {" · "}
            {passengerSummary(pax)}
          </span>
        </div>

        {error && (
          <p className="mt-3 text-sm text-danger bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-3">
            {error}
          </p>
        )}
      </div>

      {searching && (
        <div className="rounded-xl border border-hairline bg-zinc-900/50 px-4 py-8 text-center text-base text-ink-muted">
          <span className="mx-auto mb-3 block h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
          Checking live fares…
        </div>
      )}

      {!searching && searched && offers.length > 0 && (
        <div className="rounded-xl border border-hairline bg-zinc-900/70 p-4 md:p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink">
              {offers.length} flight{offers.length === 1 ? "" : "s"} found
            </h3>
            <span className="text-xs text-ink-faint">
              {[from && fromText, to && toText].filter(Boolean).join(" → ")}
            </span>
          </div>

          <ul className="space-y-2">
            {offers.map((o, i) => {
              const item = offerItem(o);
              const booking = flightBookingTarget({
                from: o.from,
                to: o.to,
                date,
                returnDate,
                bookingUrl: o.bookingUrl,
              });
              const bookTitle =
                booking.site === "the airline"
                  ? `Book ${[o.from, o.to].filter(Boolean).join(" → ") || "this flight"} on the airline site`
                  : `Search ${[o.from, o.to].filter(Boolean).join(" → ")} on ${booking.site}`;
              return (
                <li
                  key={`${item.name}-${i}`}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-surface-1 px-4 py-3 transition-colors hover:border-accent/35 hover:bg-accent/[0.06]"
                >
                  {o.airlineLogo ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={o.airlineLogo}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded-lg object-contain"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-500/15 border border-sky-400/20 text-sky-300">
                      <CategoryIcon kind="flight" className="h-4 w-4" />
                    </span>
                  )}

                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-base font-semibold text-ink">
                        {[o.legs?.[0]?.flightNumber, o.airline].filter(Boolean).join(" · ") ||
                          "Flight"}
                      </span>
                      <span className="text-xs text-ink-muted">{o.travelClass}</span>
                    </div>
                    <div className="mt-1 truncate text-sm text-ink-muted">
                      {[o.from, o.to].filter(Boolean).join(" → ")}
                      {o.fromName || o.toName ? (
                        <span className="text-ink-faint">
                          {" "}
                          · {[o.fromName, o.toName].filter(Boolean).join(" → ")}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="text-sm text-zinc-300">
                    <div className="font-semibold text-ink">
                      {clockTime(o.departAt)} → {clockTime(o.arriveAt)}
                    </div>
                    <div className="text-ink-faint">
                      {[dayLabel(o.departAt), stopsLabel(o.stops), formatMinutes(o.durationMin)]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <div className="text-md font-bold leading-none text-emerald-300">
                        {priceLabel(o.price, o.currency) ?? "—"}
                      </div>
                      <div className="mt-1 text-2xs text-ink-muted">per adult</div>
                    </div>
                    <div className="flex flex-col items-stretch gap-2">
                      <a
                        {...bookLinkProps(booking, bookTitle)}
                        className="inline-flex min-h-touch items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-sky-400/30 bg-sky-500/15 px-4 py-2 text-sm font-semibold text-sky-200 transition-colors hover:border-sky-300 hover:bg-sky-500/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                      >
                        {booking.site === "the airline" ? "Book" : `Book on ${booking.site}`}
                        <span aria-hidden>↗</span>
                      </a>
                      <AddToTripButton item={item} theme="dark" />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
