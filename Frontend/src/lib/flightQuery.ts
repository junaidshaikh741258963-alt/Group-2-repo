/**
 * Shared flight-search plumbing for the chat flight bar and the inline
 * flight card: date/party parsing, the remembered departure airport, and one
 * place that knows how to talk to /api/flights.
 */

import type { FlightOffer } from "@/lib/flightOffers";

const LAST_DEPARTURE_KEY = "tripcraft_last_departure_v1";

/** First ISO date (YYYY-MM-DD) mentioned in the trip's date text. */
export function isoDateIn(text?: string | null): string | undefined {
  const m = text?.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

/** Party size from the profile's people line ("2 adults" → 2), 1..9. */
export function adultsFrom(people?: string | null): number | undefined {
  const m = people?.match(/\d+/);
  if (!m) return undefined;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= 9 ? n : undefined;
}

/** The departure airport the user last searched from (remembered locally). */
export function readLastDeparture(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LAST_DEPARTURE_KEY);
    return v && /^[A-Z]{3}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberDeparture(code: string): void {
  if (typeof window === "undefined") return;
  if (!/^[A-Z]{3}$/.test(code)) return;
  try {
    window.localStorage.setItem(LAST_DEPARTURE_KEY, code);
  } catch {
    /* storage unavailable */
  }
}

export interface FlightSearchQuery {
  /** IATA code or city the provider understands. */
  departure: string;
  arrival: string;
  dates?: string | null;
  people?: string | null;
}

/** One POST to /api/flights. Throws with a user-safe message on failure. */
export async function searchFlights(query: FlightSearchQuery): Promise<FlightOffer[]> {
  const outboundDate = isoDateIn(query.dates);
  const adults = adultsFrom(query.people);
  const res = await fetch("/api/flights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      departure: query.departure,
      arrival: query.arrival,
      ...(outboundDate ? { outboundDate } : {}),
      ...(adults ? { adults } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { flights?: unknown; error?: unknown };
  if (!res.ok || data.error) {
    throw new Error(
      typeof data.error === "string" && data.error
        ? data.error
        : "Couldn't search flights. Try again."
    );
  }
  return Array.isArray(data.flights) ? (data.flights as FlightOffer[]) : [];
}
