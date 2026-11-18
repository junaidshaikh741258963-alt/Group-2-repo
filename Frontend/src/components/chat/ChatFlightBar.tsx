"use client";

import { useState } from "react";
import AirportField, {
  suggestionCode,
  suggestionLabel,
  type AirportSuggestion,
} from "@/components/ui/AirportField";
import AddToTripButton from "@/components/ui/AddToTripButton";
import CategoryIcon from "@/components/ui/CategoryIcon";
import { useTripItems } from "@/components/trip/TripItemsContext";
import type { FlightOffer } from "@/lib/flightOffers";
import { flightBookingTarget, bookLinkProps } from "@/lib/bookingLinks";
import { priceLabel } from "@/lib/bookingFormat";
import { isoDateIn, rememberDeparture, searchFlights } from "@/lib/flightQuery";

interface ChatFlightBarProps {
  destination: string;
  dates?: string | null;
  people?: string | null;
}

type Mode = "closed" | "search" | "manual";

function formatMin(min?: number): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function offerItem(o: FlightOffer) {
  const number = o.legs?.[0]?.flightNumber || "";
  const label = [o.airline, number].filter(Boolean).join(" ") || "Flight";
  const route = o.from && o.to ? ` · ${o.from}→${o.to}` : "";
  const parts = [
    o.departAt ? `Departs ${o.departAt}` : "",
    o.arriveAt ? `Arrives ${o.arriveAt}` : "",
    o.stops === 0 ? "Nonstop" : `${o.stops} stop${o.stops > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return {
    name: `${label}${route}`,
    category: "flight" as const,
    description: parts.join(" · "),
    price: priceLabel(o.price, o.currency),
  };
}

export default function ChatFlightBar({ destination, dates, people }: ChatFlightBarProps) {
  const [mode, setMode] = useState<Mode>("closed");
  const [dismissed, setDismissed] = useState(false);

  const [from, setFrom] = useState<AirportSuggestion | null>(null);
  const [fromText, setFromText] = useState("");
  const [offers, setOffers] = useState<FlightOffer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const [mName, setMName] = useState("");
  const [mRoute, setMRoute] = useState("");
  const [mWhen, setMWhen] = useState("");
  const [mPrice, setMPrice] = useState("");

  const { add, has, full } = useTripItems();

  if (dismissed) return null;

  const toggle = (next: Mode) => {
    setMode((cur) => (cur === next ? "closed" : next));
    setError("");
  };

  const handleSearch = async () => {
    if (!from) {
      setError("Pick a departure airport from the suggestions first.");
      return;
    }
    setError("");
    setSearching(true);
    setSearched(true);
    setOffers([]);
    try {
      const code = suggestionCode(from);
      rememberDeparture(code);
      const list = await searchFlights({ departure: code, arrival: destination, dates, people });
      setOffers(list.slice(0, 3));
      if (list.length === 0) setError("No flights found for that route.");
    } catch {
      setError("Couldn't search flights. Try again.");
    } finally {
      setSearching(false);
    }
  };

  const manualItem = {
    name: mName.trim() || "My flight",
    category: "flight" as const,
    description: [mRoute.trim(), mWhen.trim()].filter(Boolean).join(" · ") || undefined,
    price: mPrice.trim()
      ? mPrice.trim().startsWith("$")
        ? mPrice.trim()
        : `$${mPrice.trim()}`
      : undefined,
  };

  const manualSaved = has("flight", manualItem.name);

  const handleManualAdd = () => {
    if (!mName.trim() || manualSaved) return;
    if (full) {
      setError("Your trip is full — remove items from the Board or start a new trip.");
      return;
    }
    add(manualItem);
  };

  const inputCls =
    "w-full rounded-lg border border-white/10 bg-surface-2 px-3 py-2 text-sm text-ink placeholder-zinc-500 outline-none transition-colors focus:border-accent/50";

  return (
    <div className="rounded-xl border border-hairline bg-surface-1 overflow-hidden animate-fade-in">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-500/15 border border-sky-400/25 text-sky-300">
          <CategoryIcon kind="flight" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <div className="text-sm font-semibold text-zinc-200 truncate">
            Flying to {destination}?
          </div>
          <div className="text-2xs text-ink-muted truncate">
            {mode === "closed"
              ? "Find a flight or add your own. It goes straight to your trip board."
              : mode === "search"
                ? "Search live fares, then add one to your trip"
                : "Enter your booked flight details"}
          </div>
        </div>
        {mode !== "search" && (
          <button
            type="button"
            onClick={() => toggle("search")}
            className="shrink-0 rounded-lg bg-accent-strong px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-accent active:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
          >
            Find flights
          </button>
        )}
        {mode !== "manual" && (
          <button
            type="button"
            onClick={() => toggle("manual")}
            className="shrink-0 rounded-lg border border-white/10 bg-surface-1 px-4 py-3 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 hover:text-white active:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Add your own
          </button>
        )}
        <button
          type="button"
          onClick={() => (mode === "closed" ? setDismissed(true) : setMode("closed"))}
          className="relative grid shrink-0 h-9 w-9 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          aria-label={mode === "closed" ? "Dismiss flight suggestion" : "Hide flight panel"}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {mode === "search" && (
        <div className="border-t border-white/[0.06] px-3 py-3 flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div className="min-w-0">
              <AirportField
                label="From"
                value={fromText}
                placeholder="Departure city or airport (e.g. New York, JFK)"
                onInputChange={(v) => {
                  setFromText(v);
                  setFrom(null);
                }}
                onSelect={(s) => {
                  setFrom(s);
                  setFromText(suggestionLabel(s));
                }}
              />
            </div>
            <div className="flex items-center gap-2 pb-1">
              <span className="text-zinc-600">→</span>
              <span className="rounded-lg border border-white/10 bg-surface-2 px-3 py-2 text-sm font-semibold text-zinc-200">
                {destination}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSearch}
              disabled={searching || !from}
              className="rounded-lg bg-accent-strong px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-accent active:bg-blue-700 disabled:bg-surface-2 disabled:text-ink-faint disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
            >
              {searching ? "Searching…" : "Search flights"}
            </button>
            {dates && <span className="text-2xs text-ink-muted truncate">Dates: {dates}</span>}
          </div>

          {error && (
            <p
              role="alert"
              className="text-xs text-danger bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
            >
              {error}
            </p>
          )}

          {offers.length > 0 && (
            <ul className="flex flex-col gap-2">
              {offers.map((o, i) => {
                const item = offerItem(o);
                const booking = flightBookingTarget({
                  from: o.from,
                  to: o.to,
                  date: isoDateIn(dates),
                  bookingUrl: o.bookingUrl,
                });
                const bookTitle =
                  booking.site === "the airline"
                    ? "Book this flight on the airline site"
                    : `Search this route on ${booking.site}`;
                return (
                  <li
                    key={`${item.name}-${i}`}
                    className="flex items-center gap-3 rounded-xl border border-hairline bg-surface-1 px-3 py-3 transition-colors hover:border-accent/35 hover:bg-accent/[0.07]"
                  >
                    {o.airlineLogo ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={o.airlineLogo}
                        alt=""
                        className="h-6 w-6 shrink-0 object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sky-500/15 border border-sky-400/20 text-sky-300">
                        <CategoryIcon kind="flight" className="h-4 w-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-semibold text-ink truncate">
                          {o.legs?.[0]?.flightNumber || o.airline || "Flight"}
                        </span>
                        <span className="text-2xs text-ink-faint truncate">{o.airline}</span>
                      </div>
                      <div className="text-2xs text-ink-faint truncate">
                        {[o.departAt, o.arriveAt].filter(Boolean).join(" → ")}
                        {o.stops === 0
                          ? " · Nonstop"
                          : ` · ${o.stops} stop${o.stops > 1 ? "s" : ""}`}
                        {formatMin(o.durationMin) && ` · ${formatMin(o.durationMin)}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-base font-semibold text-emerald-300">
                        {priceLabel(o.price, o.currency) ?? ""}
                      </div>
                      <a
                        {...bookLinkProps(booking, bookTitle)}
                        className="mt-1 inline-flex items-center gap-1 rounded-md border border-sky-400/25 bg-sky-500/10 px-2 py-1 text-2xs font-semibold text-sky-200 transition-colors hover:border-sky-300 hover:bg-sky-500/25 hover:text-white"
                      >
                        {booking.site === "the airline" ? "Book" : `Book on ${booking.site}`}
                        <span aria-hidden>↗</span>
                      </a>
                      <div className="mt-2">
                        <AddToTripButton size="sm" theme="dark" item={item} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {searched && !searching && offers.length === 0 && !error && (
            <p className="text-xs text-ink-faint">
              No flights found. Try adding your own below.
            </p>
          )}
        </div>
      )}

      {mode === "manual" && (
        <div className="border-t border-white/[0.06] px-3 py-3 flex flex-col gap-2">
          <div className="grid gap-2 md:grid-cols-2">
            <input
              value={mName}
              onChange={(e) => setMName(e.target.value)}
              placeholder="Flight (e.g. AF 008 · JFK → CDG)"
              className={inputCls}
            />
            <input
              value={mRoute}
              onChange={(e) => setMRoute(e.target.value)}
              placeholder="Route or terminal (optional)"
              className={inputCls}
            />
            <input
              value={mWhen}
              onChange={(e) => setMWhen(e.target.value)}
              placeholder="When (e.g. May 5, 8:40 PM)"
              className={inputCls}
            />
            <input
              value={mPrice}
              onChange={(e) => setMPrice(e.target.value)}
              placeholder="Price (optional, e.g. 450)"
              className={inputCls}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleManualAdd}
              disabled={!mName.trim() || manualSaved || full}
              className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent disabled:bg-surface-2 disabled:text-ink-faint disabled:cursor-not-allowed"
            >
              {manualSaved ? (
                <span className="inline-flex items-center gap-2">
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  Added
                </span>
              ) : full ? (
                "Board full"
              ) : (
                "Add flight"
              )}
            </button>
            {manualSaved && (
              <span className="text-xs font-medium text-emerald-300">On your trip board</span>
            )}
            <button
              type="button"
              onClick={() => toggle("search")}
              className="ml-auto text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
            >
              Or search live flights →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
