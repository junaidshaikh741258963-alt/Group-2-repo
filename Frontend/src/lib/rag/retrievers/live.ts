/**
 * Live-data retriever: current hotels / restaurants / attractions / weather.
 *
 * Every call goes through the shared TTL cache + single-flight layer
 * (`@/lib/cache`), so identical questions never fan out into duplicate
 * OSM requests. Failures degrade to an empty list — RAG never blocks
 * the chat on a slow upstream.
 *
 * IMPORTANT: only real, sourced numbers become facts here. OSM has no live
 * prices, so OSM-sourced hotel docs deliberately omit price instead of
 * guessing one.
 */

import { cached, cacheKey } from "@/lib/cache";
import { config } from "@/server/config";
import { geocodeCenter, nominatimInViewbox, overpassNearby } from "@/lib/osm";
import { searchHotels } from "@/lib/hotels";
import { geocode as geocodePlace, getWeatherForecast } from "@/lib/agent/weather";
import type { RetrievedDoc, RetrievalPlan } from "../types";
import { clip } from "../tokenize";

const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

/**
 * RAG-side Overpass budgets: one mirror gets ~2.5s, the whole sweep 3.5s, so
 * even a dead mirror stack leaves time for the parallel Nominatim fallback
 * before the retrieval budget fires.
 */
const OSM_FAST = { timeoutMs: 2_500, deadlineMs: 3_500 };

/**
 * RAG-side budgets. The chat allows retrieval 4.5s total — the default
 * upstream timeout could blow that and get the whole context discarded, so
 * every RAG leg aborts earlier and degrades (fewer rows) instead of losing
 * the turn.
 */

function isoIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function originLabel(provider: string): string {
  return `live ${provider} — checked just now`;
}

/**
 * Resolve with `fallback` when a slow leg misses its slice of the retrieval
 * budget. The underlying promise keeps running (and warming its cache) — it
 * just cannot hold the answer hostage.
 */
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/* ————— hotels ————— */

interface HotelHit {
  name: string;
  price?: number;
  rating?: number;
  type?: string;
  address?: string;
}

async function osmHotels(place: string): Promise<HotelHit[]> {
  return cached<HotelHit[]>(
    cacheKey("rag:live:hotels:osm", { place: place.toLowerCase() }),
    async () => {
      const geo = await geocodeCenter(place);
      if (!geo) return [];
      // Overpass and Nominatim in parallel — whichever answers feeds the list,
      // so a dead Overpass can't stall the whole retriever. Don't wait for the
      // slow Nominatim leg when Overpass already produced a usable list.
      const list = await settleWithin(searchHotels(geo.lat, geo.lng, 6, 8, OSM_FAST), 3_000, []);
      const out: HotelHit[] = list.map((h) => ({
        name: h.name,
        rating: undefined, // OSM has no rating — do not invent one
        type: h.stars ? `${h.stars}-star listed` : undefined,
        address: h.address,
      }));
      if (out.length < 4) {
        const pois = await settleWithin(
          nominatimInViewbox("hotels", geo.lat, geo.lng, 6, 8),
          800,
          []
        );
        for (const p of pois) {
          out.push({
            name: p.name,
            rating: undefined,
            type: p.category ? `${p.category} listing` : undefined,
            address: p.address,
          });
        }
      }
      return out;
    },
    { ttlMs: config.ttl.hotels, staleMs: 30 * 60_000, cacheEmpty: false }
  );
}

function hotelDoc(
  hit: HotelHit,
  currency: string,
  budget?: RetrievalPlan["budget"],
  overBudget = false
): RetrievedDoc {
  const sym = SYMBOLS[currency] ?? (currency === "INR" ? "₹" : "$");
  const parts: string[] = [];
  parts.push(
    hit.price !== undefined
      ? `${sym}${Math.round(hit.price)} per night`
      : "price not listed by this source"
  );
  if (hit.rating !== undefined) parts.push(`rated ${hit.rating.toFixed(1)}/5`);
  if (hit.type) parts.push(hit.type);
  if (hit.address) parts.push(hit.address);
  let text = `${hit.name} — ${parts.join(", ")}`;
  if (overBudget && budget)
    text += ` (above your ${budget.currency} ${budget.amount.toLocaleString()} cap)`;
  else if (budget && hit.price === undefined) {
    text += ` (no price data — could not verify against your ${budget.currency} ${budget.amount.toLocaleString()} cap)`;
  }
  return {
    id: "",
    source: "live",
    title: hit.name,
    text: clip(text, 400),
    score: 1,
    recency: 1,
    meta: { origin: originLabel("hotel search") },
  };
}

async function liveHotels(place: string, plan: RetrievalPlan): Promise<RetrievedDoc[]> {
  const currency = plan.budget?.currency ?? "USD";
  // The hotel list comes from OpenStreetMap (Overpass + Nominatim). The paid
  // provider that used to answer first is gone, so the free sweep is the
  // source — it carries no nightly price or rating, and the document says so
  // rather than inventing one.
  const hits = (await osmHotels(place).catch(() => [] as HotelHit[])).filter((h) => h.name);

  const seen = new Set<string>();
  let docs: RetrievedDoc[] = [];
  for (const h of hits) {
    const key = h.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    docs.push(hotelDoc(h, currency, plan.budget));
    if (docs.length >= 6) break;
  }

  const budget = plan.budget;
  if (budget && docs.length > 0) {
    const priced = hits.filter((h) => h.name && h.price !== undefined);
    if (priced.length > 0) {
      const under = priced
        .filter((h) => (h.price as number) <= budget.amount)
        .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
      const over = priced
        .filter((h) => (h.price as number) > budget.amount)
        .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
      const picked: RetrievedDoc[] = under.slice(0, 5).map((h) => hotelDoc(h, currency, budget));
      // Nothing under the cap → show the cheapest options, clearly marked, so
      // the model can honestly say "nothing under X; closest are …".
      if (picked.length < 3) {
        for (const h of over.slice(0, 3 - picked.length))
          picked.push(hotelDoc(h, currency, budget, true));
      }
      docs = picked;
    }
  }

  for (let i = 0; i < docs.length; i++) docs[i] = { ...docs[i], id: `live-hotel-${i}` };
  return docs;
}

/* ————— restaurants & attractions ————— */

interface PlaceHit {
  name: string;
  category?: string;
  address?: string;
  hours?: string;
  rating?: number;
  price?: string;
}

async function livePlaces(place: string, query: string): Promise<RetrievedDoc[]> {
  const geo = await cached<{ lat: number; lng: number } | null>(
    cacheKey("rag:live:geo", { place: place.toLowerCase() }),
    () => geocodeCenter(place),
    { ttlMs: config.ttl.geocode, cacheEmpty: false }
  );
  if (!geo) return [];

  // Overpass (rich: hours/phone) and Nominatim (plain but reliable) in
  // parallel; Nominatim results are only merged when the rich sources are
  // thin. Crucially, don't wait for the slowest leg once Overpass has already
  // produced a usable list — Retrieval overall has a 4s deadline, and a slow
  // Nominatim must never erase the knowledge hits that are already ready.
  const osmPromise = cached<PlaceHit[]>(
    cacheKey("rag:live:places", { place: place.toLowerCase(), query }),
    async () => {
      const points = await overpassNearby({
        lat: geo.lat,
        lng: geo.lng,
        query,
        radiusKm: 5,
        limit: 8,
        ...OSM_FAST,
      });
      return points.map((p) => ({
        name: p.name,
        category: p.category,
        address: p.address,
        hours: p.openingHours,
      }));
    },
    { ttlMs: config.ttl.places, staleMs: 15 * 60_000, cacheEmpty: false }
  ).catch(() => [] as PlaceHit[]);
  const nmkPromise = cached<PlaceHit[]>(
    cacheKey("rag:live:nominatim", { place: place.toLowerCase(), query }),
    async () => {
      const list = await nominatimInViewbox(query, geo.lat, geo.lng, 5, 8);
      return list.map((p) => ({ name: p.name, category: p.category, address: p.address }));
    },
    { ttlMs: config.ttl.places, staleMs: 15 * 60_000, cacheEmpty: false }
  ).catch(() => [] as PlaceHit[]);

  const osm = await Promise.race([
    osmPromise,
    new Promise<PlaceHit[]>((resolve) => setTimeout(() => resolve([]), 3_000)),
  ]);
  const hits = [...osm];

  if (hits.length < 3) {
    const nmk = await Promise.race([
      nmkPromise,
      new Promise<PlaceHit[]>((resolve) => setTimeout(() => resolve([]), 800)),
    ]);
    hits.push(...nmk);
  }

  const seen = new Set<string>();
  const docs: RetrievedDoc[] = [];
  for (const h of hits) {
    const key = h.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const parts: string[] = [];
    if (h.category) parts.push(h.category);
    if (h.rating !== undefined) parts.push(`rated ${h.rating.toFixed(1)}/5`);
    if (h.price) parts.push(h.price);
    if (h.address) parts.push(h.address);
    if (h.hours) parts.push(`hours: ${h.hours}`);
    docs.push({
      id: `live-place-${docs.length}`,
      source: "live",
      title: h.name,
      text: clip(`${h.name} — ${parts.join(", ")}`, 400),
      score: 1,
      recency: 1,
      meta: {
        origin: originLabel(
          /restaurant|cafe|bar|food/i.test(query) ? "place search" : "attraction search"
        ),
      },
    });
    if (docs.length >= 6) break;
  }
  return docs;
}

/* ————— weather ————— */

async function liveWeather(place: string): Promise<RetrievedDoc[]> {
  const geo = await cached<{ lat: number; lng: number } | null>(
    cacheKey("rag:live:geo", { place: place.toLowerCase() }),
    () => geocodePlace(place),
    { ttlMs: config.ttl.geocode, cacheEmpty: false }
  );
  if (!geo) return [];

  const start = isoIn(0);
  const end = isoIn(4);
  const forecast = await cached(
    cacheKey("rag:live:weather", { place: place.toLowerCase(), start, end }),
    () => getWeatherForecast(geo.lat, geo.lng, start, end),
    { ttlMs: config.ttl.weather, staleMs: 6 * 3_600_000, cacheEmpty: false }
  );

  return forecast.slice(0, 5).map((f, i) => ({
    id: `live-weather-${i}`,
    source: "live",
    title: `Weather ${f.date} in ${place}`,
    text: clip(
      `${f.date}: ${f.description}, high ${f.highC}°C / low ${f.lowC}°C, precipitation ${f.precipitationMm} mm, wind ${f.windSpeedKmh} km/h`,
      260
    ),
    score: 1,
    recency: 1,
    meta: { origin: originLabel("Open-Meteo forecast") },
  }));
}

/* ————— entry ————— */

export async function retrieveLive(plan: RetrievalPlan): Promise<RetrievedDoc[]> {
  const place = plan.place?.trim();
  if (!place || !plan.liveKind) return [];
  try {
    const docs = await (async () => {
      switch (plan.liveKind) {
        case "hotel":
          return await liveHotels(place, plan);
        case "food":
          return await livePlaces(place, plan.liveQuery?.trim() || "restaurants");
        case "sight":
          return await livePlaces(place, plan.liveQuery?.trim() || "tourist attractions");
        case "weather":
          return await liveWeather(place);
        default:
          return [];
      }
    })();
    if (docs.length === 0) {
      console.warn(`[rag:live] no results for ${plan.liveKind} in "${place}"`);
    }
    return docs;
  } catch (err) {
    console.warn("[rag:live] retrieval failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
