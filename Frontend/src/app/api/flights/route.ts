import { NextRequest } from "next/server";
import { searchLocalAirports, resolveLocalAirport } from "@/lib/airports";
import type { AirportSuggestion } from "@/lib/airports";
import { octotripSearch, octoToOffer } from "@/lib/octotrip";
import type { FlightOffer } from "@/lib/flightOffers";

export const runtime = "nodejs";
export type { AirportSuggestion };

const AIRPORT_BY_CITY: Record<string, string> = {
  "new york": "JFK",
  nyc: "JFK",
  manhattan: "JFK",
  tokyo: "NRT",
  "tokyo japan": "NRT",
  london: "LHR",
  paris: "CDG",
  "los angeles": "LAX",
  "san francisco": "SFO",
  chicago: "ORD",
  miami: "MIA",
  dubai: "DXB",
  singapore: "SIN",
  "hong kong": "HKG",
  bangkok: "BKK",
  rome: "FCO",
  barcelona: "BCN",
  amsterdam: "AMS",
  berlin: "BER",
  sydney: "SYD",
  toronto: "YYZ",
  vancouver: "YVR",
  delhi: "DEL",
  mumbai: "BOM",
  seoul: "ICN",
  shanghai: "PVG",
  beijing: "PEK",
  "kuala lumpur": "KUL",
  bali: "DPS",
  istanbul: "IST",
  lisbon: "LIS",
  madrid: "MAD",
  munich: "MUC",
  zurich: "ZRH",
  venice: "VCE",
  florence: "FLR",
  athens: "ATH",
  copenhagen: "CPH",
  stockholm: "ARN",
  oslo: "OSL",
  helsinki: "HEL",
  dublin: "DUB",
  edinburgh: "EDI",
  manchester: "MAN",
  boston: "BOS",
  washington: "IAD",
  seattle: "SEA",
  denver: "DEN",
  atlanta: "ATL",
  dallas: "DFW",
  houston: "IAH",
  "las vegas": "LAS",
  orlando: "MCO",
  honolulu: "HNL",
  "mexico city": "MEX",
  "buenos aires": "EZE",
  "sao paulo": "GRU",
  cairo: "CAI",
  nairobi: "NBO",
  johannesburg: "JNB",
  "cape town": "CPT",
  marrakech: "RAK",
  "tel aviv": "TLV",
  doha: "DOH",
  "abu dhabi": "AUH",
  taipei: "TPE",
  manila: "MNL",
  "ho chi minh": "SGN",
  hanoi: "HAN",
  phuket: "HKT",
  reykjavik: "KEF",
  bogota: "BOG",
  lima: "LIM",
  santiago: "SCL",
};

function resolveAirportCode(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
  if (value.startsWith("/m/") || value.startsWith("/g/")) return value;
  const lower = value.toLowerCase();
  if (AIRPORT_BY_CITY[lower]) return AIRPORT_BY_CITY[lower];
  const withoutCountry = lower.split(",")[0].trim();
  if (AIRPORT_BY_CITY[withoutCountry]) return AIRPORT_BY_CITY[withoutCountry];
  return null;
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Airport suggestions come from the bundled index (see lib/airports.ts). */
async function fetchSuggestions(q: string): Promise<AirportSuggestion[]> {
  return searchLocalAirports(q, 8);
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** 2 = title starts with the query, 1 = contains it, 0 = unrelated. */
function matchScore(title: string, query: string): number {
  const t = normalizeText(title);
  const q = normalizeText(query);
  if (!q) return 0;
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

/** Quick local resolution first, then the bundled index, then autocomplete. */
async function resolveAirport(raw: string): Promise<string | null> {
  const quick = resolveAirportCode(raw);
  if (quick) return quick;
  const value = raw.trim();
  if (!value) return null;
  const local = resolveLocalAirport(value);
  if (local) return local;
  const suggestions = await fetchSuggestions(value);
  const strict = normalizeText(value).length <= 3;
  const ranked = suggestions
    .map((s) => ({ s, score: matchScore(s.title, value) }))
    .filter((x) => x.score > 0 && (!strict || x.score === 2))
    .sort((a, b) => b.score - a.score);
  const withAirport = ranked.find((x) => x.s.airports.length > 0);
  if (withAirport) return withAirport.s.airports[0].code;
  return ranked[0]?.s.id ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === "autocomplete") {
      const q = String(body.q ?? "").trim();
      if (q.length < 2) return Response.json({ suggestions: [] });
      const suggestions = await fetchSuggestions(q);
      return Response.json({ suggestions });
    }

    const departure = await resolveAirport(String(body.departure ?? body.from ?? ""));
    const arrival = await resolveAirport(String(body.arrival ?? body.to ?? ""));
    if (!departure || !arrival) {
      return Response.json(
        {
          error: "Could not find that airport. Try a city, airport, or code (e.g. Paris, JFK).",
          flights: [],
        },
        { status: 400 }
      );
    }

    const outboundDate =
      typeof body.outboundDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.outboundDate)
        ? body.outboundDate
        : isoInDays(14);

    const returnDate =
      typeof body.returnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.returnDate)
        ? body.returnDate
        : undefined;

    const adults =
      typeof body.adults === "number" && body.adults >= 1 && body.adults <= 9 ? body.adults : 1;

    let best: FlightOffer[] = [];
    let other: FlightOffer[] = [];

    // OctoTrip is the flight source — the paid provider that used to answer
    // first is gone.
    const octo = await octotripSearch({
      origin: departure,
      destination: arrival,
      departureDate: outboundDate,
      returnDate,
      adults,
      currency: "USD",
    });
    const mapped = (octo ?? [])
      .map((r, i) => octoToOffer(r, i < 5 ? "best" : "other"))
      .filter((o): o is FlightOffer => o !== null);
    if (mapped.length === 0) {
      return Response.json(
        {
          error: "Flight search is unavailable right now — try again in a bit.",
          flights: [],
          best: [],
          other: [],
        },
        { status: 503 }
      );
    }
    best = mapped.filter((o) => o.kind === "best");
    other = mapped.filter((o) => o.kind === "other").slice(0, 8);
    const provider = "OctoTrip";

    return Response.json({
      best,
      other,
      flights: [...best, ...other],
      departure,
      arrival,
      outboundDate,
      returnDate: returnDate || null,
      provider,
    });
  } catch (err) {
    console.error("Flights search error:", err);
    return Response.json(
      { error: "Flight search failed. Please try again.", flights: [], best: [], other: [] },
      { status: 500 }
    );
  }
}
