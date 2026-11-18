import { NextRequest } from "next/server";
import { localIsoWithOffset } from "@/lib/bookingFormat";
import { suggestIndiaStations, resolveIndiaStation, searchIndiaTrains } from "@/lib/indiaRail";
import { suggestUkStations, resolveUkStation, searchUkJourneys } from "@/lib/ukRail";
import type { StationSuggestion, TrainJourney, TrainLeg } from "@/lib/trains";

export const runtime = "nodejs";

const HAFAS_BASE = (process.env.HAFAS_BASE_URL || "https://v6.vbb.transport.rest").replace(
  /\/+$/,
  ""
);
const HAFAS_TZ = process.env.HAFAS_TIMEZONE || "Europe/Berlin";
const TIMEOUT_MS = 15000;

const COVERAGE_HINT =
  "That station could not be found. We cover India, the UK and German long-distance rail (e.g. New Delhi, NDLS, London Euston, Berlin Hbf, München Hbf).";

/**
 * English exonyms → the local names VBB's station index actually contains.
 * Without this, "Munich Hbf" silently resolved to Berlin Hbf (the first
 * fuzzy match), producing a route the traveller never asked for.
 */
const HAFAS_ALIASES: Record<string, string> = {
  munich: "München",
  cologne: "Köln",
  nuremberg: "Nürnberg",
  hanover: "Hannover",
  brunswick: "Braunschweig",
  vienna: "Wien",
  prague: "Praha",
};

/** Words that do not identify a place ("Berlin Hbf" → "berlin"). */
const STATION_STOPWORDS = new Set([
  "hbf",
  "hauptbahnhof",
  "bahnhof",
  "station",
  "stop",
  "central",
  "centraal",
  "gare",
  "airport",
  "flughafen",
  "the",
  "and",
  "de",
  "du",
  "des",
  "der",
  "die",
  "das",
]);

function normalizePlace(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function applyHafasAliases(value: string): string {
  return value.replace(/\b[A-Za-zäöüß]+\b/g, (word) => HAFAS_ALIASES[word.toLowerCase()] ?? word);
}

/** First meaningful token — the city or town the query names. */
function primaryPlace(value: string): string {
  const tokens = normalizePlace(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.find((t) => t.length >= 3 && !STATION_STOPWORDS.has(t)) ?? "";
}

/** Whole-word check so "Bern" never matches "Bernau bei Berlin". */
function mentionsPlace(stationName: string, place: string): boolean {
  if (!place) return false;
  const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(normalizePlace(stationName));
}

interface HafasLocation {
  type?: string;
  id?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
}

interface HafasLeg {
  origin?: { name?: string };
  destination?: { name?: string };
  departure?: string;
  arrival?: string;
  walking?: boolean;
  distance?: number;
  direction?: string;
  line?: {
    name?: string;
    product?: string;
    mode?: string;
    operator?: { name?: string };
  };
}

interface HafasJourney {
  legs?: HafasLeg[];
  price?: { amount?: number; currency?: string };
}

async function hafasGet(
  path: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  const url = new URL(`${HAFAS_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": "TripCraft/1.0" },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string; hafasMessage?: string };
      detail = body.message || body.hafasMessage || "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `Train service returned ${res.status}`);
  }

  return res.json();
}

async function searchStations(query: string): Promise<StationSuggestion[]> {
  const data = await hafasGet("/locations", {
    query,
    results: 8,
    poi: false,
    addresses: false,
    lines: 1,
  });

  const raw = Array.isArray(data) ? (data as HafasLocation[]) : [];
  return raw
    .filter((s) => typeof s?.id === "string" && typeof s?.name === "string" && s.name.trim())
    .map((s) => ({
      id: String(s.id),
      name: String(s.name),
      type: s.type === "stop" || s.type === "station" ? s.type : "stop",
      lat: typeof s.latitude === "number" ? s.latitude : undefined,
      lng: typeof s.longitude === "number" ? s.longitude : undefined,
    }));
}

/** Station ids pass through; anything else is resolved as a place name. */
async function resolveHafasStation(raw: string): Promise<string> {
  const value = raw.trim();
  if (!value) return "";
  if (/^\d{4,}$/.test(value)) return value;
  const query = applyHafasAliases(value);
  const place = primaryPlace(query);
  if (!place) return "";
  const matches = await searchStations(query);
  // Only accept a station that actually names the requested place. VBB's
  // location search is fuzzy and happily returns Berlin stops for a query
  // about Amsterdam; taking matches[0] turned those into confident routes.
  const best = matches.find((s) => mentionsPlace(s.name, place));
  return best?.id || "";
}

function minutesBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

function simplifyJourney(journey: HafasJourney): TrainJourney | null {
  const legs = (Array.isArray(journey.legs) ? journey.legs : []).filter(
    (leg) => leg && (leg.departure || leg.arrival)
  );
  if (legs.length === 0) return null;

  const first = legs[0];
  const last = legs[legs.length - 1];
  const rides = legs.filter((leg) => leg.line && !leg.walking);
  const departAt = first.departure || "";
  const arriveAt = last.arrival || "";
  const durationMin = minutesBetween(departAt, arriveAt) ?? 0;

  const simplifiedLegs: TrainLeg[] = legs.map((leg) => ({
    kind: leg.line && !leg.walking ? "ride" : "walk",
    line: leg.line?.name || "",
    product: leg.line?.product || leg.line?.mode || "",
    operator: leg.line?.operator?.name || "",
    direction: leg.direction || "",
    from: leg.origin?.name || "",
    to: leg.destination?.name || "",
    depart: leg.departure || "",
    arrive: leg.arrival || "",
    durationMin: minutesBetween(leg.departure, leg.arrival),
  }));

  return {
    departAt,
    arriveAt,
    durationMin,
    transfers: Math.max(rides.length - 1, 0),
    from: first.origin?.name || "",
    to: last.destination?.name || "",
    price: typeof journey.price?.amount === "number" ? journey.price.amount : undefined,
    currency: journey.price?.currency || undefined,
    legs: simplifiedLegs,
  };
}

type Route = "india" | "uk" | "hafas";

function normalized(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Merges India + UK + HAFAS autocomplete, prefix matches first, deduped. */
async function suggestStations(q: string): Promise<StationSuggestion[]> {
  const hafasQuery = applyHafasAliases(q);
  const hafasPlace = primaryPlace(hafasQuery);
  const [india, uk, hafas] = await Promise.allSettled([
    suggestIndiaStations(q, 4),
    suggestUkStations(q, 3),
    searchStations(hafasQuery),
  ]);

  const sources = [india, uk, hafas];
  const merged: { s: StationSuggestion; score: number; order: number }[] = [];
  const seen = new Set<string>();
  const nq = normalized(q);

  sources.forEach((result, order) => {
    if (result.status !== "fulfilled") return;
    for (const s of result.value) {
      if (!s?.id || seen.has(s.id)) continue;
      // VBB's index answers "Amsterdam Centraal" with stops in Elsterwerda.
      // Only offer a German suggestion when its name names the place asked for.
      if (order === 2 && hafasPlace && !mentionsPlace(s.name, hafasPlace)) continue;
      seen.add(s.id);
      const label = normalized(s.name);
      const code = normalized(s.id.split(":").pop() || "");
      const score = label.startsWith(nq) || code === nq || code.startsWith(nq) ? 0 : 1;
      merged.push({ s, score, order });
    }
  });

  merged.sort((a, b) => a.score - b.score || a.order - b.order);
  return merged.slice(0, 8).map((m) => m.s);
}

async function resolveBoth(
  route: Route,
  fromQuery: string,
  toQuery: string
): Promise<[string, string] | null> {
  // The route is picked by probing providers, so a provider that rejects a
  // query (e.g. the Indian feed 404s on a German station id) must hand over
  // to the next one instead of failing the whole search.
  const safe = (query: string) => {
    const p =
      route === "india"
        ? resolveIndiaStation(query)
        : route === "uk"
          ? resolveUkStation(query)
          : resolveHafasStation(query);
    return p.catch(() => "");
  };
  const [from, to] = await Promise.all([safe(fromQuery), safe(toQuery)]);
  return from && to && from !== to ? [from, to] : null;
}

/** Picks the provider from id prefixes or by probing India → UK → HAFAS. */
async function resolveRoute(
  fromQuery: string,
  toQuery: string
): Promise<{ route: Route; fromId: string; toId: string } | null> {
  const fromUpper = fromQuery.toUpperCase();
  const toUpper = toQuery.toUpperCase();

  let forced: Route | null = null;
  const hafasId = (v: string) => /^\d{4,}$/.test(v);
  if (fromUpper.startsWith("IN:") || toUpper.startsWith("IN:")) forced = "india";
  else if (fromUpper.startsWith("UK:") || toUpper.startsWith("UK:")) forced = "uk";
  else if (
    fromQuery.includes(":") ||
    toQuery.includes(":") ||
    hafasId(fromQuery) ||
    hafasId(toQuery)
  )
    forced = "hafas";

  const order: Route[] = forced ? [forced] : ["india", "uk", "hafas"];
  for (const route of order) {
    const resolved = await resolveBoth(route, fromQuery, toQuery);
    if (resolved) return { route, fromId: resolved[0], toId: resolved[1] };
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (body.action === "autocomplete") {
      const q = String(body.q ?? "").trim();
      if (q.length < 2) return Response.json({ suggestions: [] });
      const suggestions = await suggestStations(q);
      return Response.json({ suggestions });
    }

    const fromQuery = String(body.from ?? body.departure ?? "").trim();
    const toQuery = String(body.to ?? body.arrival ?? "").trim();
    if (!fromQuery || !toQuery) {
      return Response.json(
        { error: "Pick a departure and an arrival station.", trains: [] },
        { status: 400 }
      );
    }

    const date =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const time =
      typeof body.time === "string" && /^\d{2}:\d{2}$/.test(body.time) ? body.time : "09:00";

    const resolved = await resolveRoute(fromQuery, toQuery);
    if (!resolved) {
      return Response.json({ error: COVERAGE_HINT, trains: [] }, { status: 400 });
    }
    const { route, fromId, toId } = resolved;

    if (route === "india") {
      const result = await searchIndiaTrains(
        fromId.replace(/^IN:/i, ""),
        toId.replace(/^IN:/i, ""),
        date
      );
      return Response.json({
        trains: result.trains,
        date,
        time,
        fromId,
        toId,
        route,
        provider: result.provider,
      });
    }

    if (route === "uk") {
      const result = await searchUkJourneys(
        fromId.replace(/^UK:/i, ""),
        toId.replace(/^UK:/i, ""),
        date,
        time
      );
      return Response.json({
        trains: result.trains,
        date,
        time,
        fromId,
        toId,
        route,
        provider: result.provider,
      });
    }

    const data = await hafasGet("/journeys", {
      from: fromId,
      to: toId,
      departure: localIsoWithOffset(date, time, HAFAS_TZ),
      results: 6,
      stopovers: false,
      remarks: false,
      language: "en",
    });

    const journeys = (data as { journeys?: HafasJourney[] })?.journeys ?? [];
    const trains = journeys
      .map(simplifyJourney)
      .filter((t): t is TrainJourney => Boolean(t && t.departAt && t.arriveAt));

    return Response.json({
      trains,
      date,
      time,
      fromId,
      toId,
      route,
      provider: new URL(HAFAS_BASE).hostname,
    });
  } catch (err) {
    console.error("Train search error:", err);
    const message = err instanceof Error ? err.message : "Train search failed";
    return Response.json({ error: message, trains: [] }, { status: 502 });
  }
}
