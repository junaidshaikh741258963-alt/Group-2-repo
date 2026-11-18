import type { FlightOffer } from "@/lib/flightOffers";

/**
 * OctoTrip's public flight-search MCP endpoint. Free, no account and no API
 * key, worldwide coverage — used as the fallback when the paid search
 * provider is rate-limited. Results are affiliate-linked by them.
 */
const MCP_URL = "https://mcp.octotrip.app/flights/mcp";
const TIMEOUT_MS = 45000;

interface OctoLeg {
  flight_number?: string;
  carrier?: string;
  aircraft?: string;
  departure?: string;
  arrival?: string;
  departure_time?: string;
  arrival_time?: string;
  departure_date?: string;
  arrival_date?: string;
  duration_minutes?: number;
}

interface OctoLegSet {
  departure?: string;
  arrival?: string;
  departure_time?: string;
  arrival_time?: string;
  departure_date?: string;
  arrival_date?: string;
  duration_minutes?: number;
  stops?: number;
  legs?: OctoLeg[];
}

export interface OctoTripResult {
  airline?: string;
  airline_code?: string;
  flight_numbers?: string[];
  is_direct?: boolean;
  stops?: number;
  total_duration_minutes?: number;
  outbound?: OctoLegSet;
  return?: OctoLegSet | null;
  price?: number;
  currency?: string;
  booking_url?: string;
  baggage?: string;
  gate?: string;
}

interface RpcEnvelope {
  result?: {
    content?: { type?: string; text?: string }[];
  };
  error?: { message?: string };
}

function stamp(date?: string, time?: string): string {
  if (!date && !time) return "";
  return [date, time].filter(Boolean).join(" ");
}

/** SSE-ish MCP response → JSON-RPC envelope. */
function parseMcpBody(body: string): RpcEnvelope | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim()) as RpcEnvelope;
    } catch {
      /* keep scanning other data lines */
    }
  }
  try {
    return JSON.parse(body) as RpcEnvelope;
  } catch {
    return null;
  }
}

export async function octotripSearch(params: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  currency?: string;
}): Promise<OctoTripResult[] | null> {
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: {
            origin: params.origin,
            destination: params.destination,
            departure_date: params.departureDate,
            ...(params.returnDate ? { return_date: params.returnDate } : {}),
            adults: params.adults,
            currency: params.currency || "USD",
          },
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const envelope = parseMcpBody(await res.text());
    const text = envelope?.result?.content?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as { results?: OctoTripResult[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch (err) {
    console.warn("OctoTrip search failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export function octoToOffer(raw: OctoTripResult, kind: string): FlightOffer | null {
  const out = raw.outbound;
  if (!out) return null;

  const departAt = stamp(out.departure_date, out.departure_time);
  const arriveAt = stamp(out.arrival_date, out.arrival_time);
  const legs = (Array.isArray(out.legs) ? out.legs : []).map((leg) => ({
    from: leg.departure || "",
    to: leg.arrival || "",
    depart: stamp(leg.departure_date, leg.departure_time),
    arrive: stamp(leg.arrival_date, leg.arrival_time),
    airline: leg.carrier || raw.airline || "",
    logo: "",
    flightNumber: leg.flight_number || "",
    durationMin: typeof leg.duration_minutes === "number" ? leg.duration_minutes : undefined,
  }));

  return {
    kind,
    price: typeof raw.price === "number" ? raw.price : undefined,
    currency: raw.currency || undefined,
    durationMin:
      typeof raw.total_duration_minutes === "number"
        ? raw.total_duration_minutes
        : typeof out.duration_minutes === "number"
          ? out.duration_minutes
          : undefined,
    stops:
      typeof raw.stops === "number"
        ? raw.stops
        : typeof out.stops === "number"
          ? out.stops
          : Math.max(legs.length - 1, 0),
    airline: raw.airline || "",
    airlineLogo: "",
    travelClass: "Economy",
    departAt,
    arriveAt,
    from: out.departure || "",
    to: out.arrival || "",
    fromName: "",
    toName: "",
    legs,
    bookingUrl: raw.booking_url || undefined,
  };
}
