"use client";

import { memo } from "react";
import type { FlightOffer } from "@/lib/flightOffers";
import { bookLinkProps, flightBookingTarget } from "@/lib/bookingLinks";
import { freshness } from "@/lib/weather";

interface FlightCardProps {
  offers: FlightOffer[];
  /** Route + dates the search ran with, for pre-filled booking links. */
  from?: string;
  to?: string;
  date?: string;
  returnDate?: string;
  fetchedAt: number;
  onOpen?: (offer: FlightOffer) => void;
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16) || iso;
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function duration(min?: number): string {
  if (!min) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Flight options found by a live search. Prices/times come from the provider
 * as-is with a "updated" stamp; every row hands off to the provider's site
 * (deep link when the provider gives one) — nothing is booked in-app.
 */
function FlightCard({ offers, from, to, date, returnDate, fetchedAt, onOpen }: FlightCardProps) {
  const shown = offers.slice(0, 3);
  if (shown.length === 0) return null;

  return (
    <section
      aria-label="Flight options"
      className="animate-card-in mt-3 overflow-hidden rounded-2xl border border-white/10 bg-surface-2/60"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-base" aria-hidden>
          ✈️
        </span>
        <h4 className="text-sm font-semibold text-ink">
          Flights {from && to ? `${from} → ${to}` : ""}
        </h4>
        <span className="ml-auto text-2xs text-ink-faint">
          Live search · {freshness(fetchedAt)}
        </span>
      </div>

      <ul className="divide-y divide-white/8" role="list">
        {shown.map((o, i) => {
          const target = flightBookingTarget({
            from: o.from || from,
            to: o.to || to,
            date,
            returnDate,
            bookingUrl: o.bookingUrl,
          });
          return (
            <li key={`${o.airline}-${o.departAt}-${i}`} className="flex items-center gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{o.airline || "Flight"}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  <span className="tabular-nums">{clock(o.departAt)}</span>
                  {" → "}
                  <span className="tabular-nums">{clock(o.arriveAt)}</span>
                  {o.stops === 0 ? " · Direct" : ` · ${o.stops} stop${o.stops > 1 ? "s" : ""}`}
                  {duration(o.durationMin) ? ` · ${duration(o.durationMin)}` : ""}
                </p>
              </div>
              {typeof o.price === "number" && (
                <p className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                  {o.currency === "USD" ? "$" : ""}
                  {o.price.toLocaleString("en-US")}
                  {o.currency && o.currency !== "USD" ? ` ${o.currency}` : ""}
                </p>
              )}
              <a
                {...bookLinkProps(target, `Check this fare on ${target.site}`)}
                className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
              >
                Book on {target.site}
              </a>
              {onOpen && (
                <button
                  type="button"
                  onClick={() => onOpen(o)}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-white/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                >
                  Details
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-white/10 bg-zinc-950/30 px-3 py-2 text-2xs text-ink-faint">
        Prices and availability are confirmed on the provider — booking happens there, not here.
      </p>
    </section>
  );
}

export default memo(FlightCard);
