import type { StationSuggestion, TrainJourney, TrainLeg } from "@/lib/trains";
import { arrivalStamp, clockDiff } from "@/lib/bookingFormat";

/**
 * UK National Rail journey planning via railinfo.uk — a free JSON API over
 * Network Rail's open Darwin feed, no key and no account required.
 */
const HOST = "https://api.railinfo.uk";
const TIMEOUT_MS = 20000;

interface UkStation {
  crs?: string;
  tiploc?: string;
  description?: string;
}

interface UkLeg {
  from_name?: string;
  to_name?: string;
  dep?: string;
  arr?: string;
  dep_platform?: string;
  atoc_code?: string;
  headcode?: string;
  status?: string;
}

interface UkJourney {
  dep?: string;
  arr?: string;
  duration_min?: number;
  changes?: number;
  legs?: UkLeg[];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** "1950" → "19:50". */
function hhmm(value?: string | null): string | null {
  const raw = (value || "").trim();
  if (!/^\d{4}$/.test(raw)) return /^\d{2}:\d{2}$/.test(raw) ? raw : null;
  const hh = Number(raw.slice(0, 2));
  const mm = Number(raw.slice(2, 4));
  if (hh > 23 || mm > 59) return null;
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${HOST}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": "TripCraft/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`UK rail API returned ${res.status}`);
  return (await res.json()) as T;
}

/** UK station autocomplete — validated so non-UK queries come back empty. */
export async function suggestUkStations(query: string, limit = 4): Promise<StationSuggestion[]> {
  const q = normalize(query);
  if (q.length < 2) return [];

  const list = await getJson<UkStation[]>("/stations", { q: query.trim() });
  if (!Array.isArray(list)) return [];

  const out: StationSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const crs = (s.crs || "").trim().toUpperCase();
    const name = (s.description || "").trim();
    if (!crs || !name || seen.has(crs)) continue;
    const matchesCrs = crs.toLowerCase() === q;
    const matchesName = normalize(name).startsWith(q);
    if (!matchesCrs && !matchesName) continue;
    seen.add(crs);
    out.push({ id: `UK:${crs}`, name: `${name} (${crs})`, type: "station" });
    if (out.length >= limit) break;
  }
  return out;
}

export async function resolveUkStation(raw: string): Promise<string | null> {
  const value = raw.trim();
  if (!value) return null;
  if (value.toUpperCase().startsWith("UK:")) return value.slice(3).toUpperCase();
  if (/^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
  const matches = await suggestUkStations(value, 1);
  return matches[0]?.id.slice(3) ?? null;
}

function buildJourney(j: UkJourney, date: string): TrainJourney | null {
  const dep = hhmm(j.dep);
  const arr = hhmm(j.arr);
  if (!dep || !arr) return null;

  let durationMin = Number(j.duration_min);
  if (!Number.isFinite(durationMin) || durationMin <= 0) durationMin = clockDiff(dep, arr);

  const rawLegs = Array.isArray(j.legs) ? j.legs : [];
  const legs: TrainLeg[] = rawLegs
    .map((leg): TrainLeg | null => {
      const legDep = hhmm(leg.dep);
      const legArr = hhmm(leg.arr);
      if (!legDep || !legArr) return null;
      const legMin = clockDiff(legDep, legArr);
      return {
        kind: "ride",
        line: (leg.atoc_code || leg.headcode || "").trim(),
        product: "rail",
        operator: (leg.atoc_code || "").trim(),
        direction: leg.headcode || "",
        from: leg.from_name || "",
        to: leg.to_name || "",
        depart: `${date} ${legDep}`,
        arrive: arrivalStamp(date, legDep, legMin),
        durationMin: legMin,
      };
    })
    .filter((leg) => leg !== null);

  const departAt = `${date} ${dep}`;
  const arriveAt = arrivalStamp(date, dep, durationMin);

  return {
    departAt,
    arriveAt,
    durationMin,
    transfers: Number.isFinite(Number(j.changes)) ? Number(j.changes) : 0,
    from: rawLegs[0]?.from_name || "",
    to: rawLegs[rawLegs.length - 1]?.to_name || "",
    legs,
  };
}

export interface UkTrainSearch {
  trains: TrainJourney[];
  provider: string;
}

export async function searchUkJourneys(
  fromCrs: string,
  toCrs: string,
  date: string,
  time: string
): Promise<UkTrainSearch> {
  if (fromCrs.toUpperCase() === toCrs.toUpperCase()) {
    throw new Error("Origin and destination are the same station.");
  }

  const data = await getJson<{ journeys?: UkJourney[] }>("/journeys", {
    from: fromCrs.toUpperCase(),
    to: toCrs.toUpperCase(),
    date,
    time: time.replace(":", ""),
  });

  const trains = (Array.isArray(data.journeys) ? data.journeys : [])
    .map((j) => buildJourney(j, date))
    .filter((j): j is TrainJourney => j !== null);

  return { trains, provider: "UK National Rail" };
}
