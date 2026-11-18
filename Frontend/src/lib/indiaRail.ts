import type { StationSuggestion, TrainJourney, TrainLeg } from "@/lib/trains";
import { arrivalStamp, clockDiff } from "@/lib/bookingFormat";

/**
 * Keyless Indian Railways access:
 *  - ConfirmTkt's public web API (their own frontend constants, no account)
 *  - eRail's tilde-delimited feed as a fallback
 * Both are unofficial, best-effort feeds rather than IRCTC partner APIs.
 */
const CT_HOST = "https://cttrainsapi.confirmtkt.com";
const ERAIL_HOST = "https://erail.in";
const TIMEOUT_MS = 20000;

const CT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  clientid: "ct-web",
  apikey: "ct-web!2$",
  deviceid: "tripcraft-0000-0000-0000-000000000000",
  "User-Agent": "TripCraft/1.0",
};

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "text/plain, */*",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) TripCraft/1.0",
};

function normalize(value?: string | null): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** "16.55" / "4:5" → "16:55" / "04:05"; null when unusable. */
function normaliseClock(value?: string | null): string | null {
  const raw = (value || "").trim();
  const m = raw.match(/^(\d{1,2})[:.](\d{1,2})$/);
  if (!m) return /^\d{2}:\d{2}$/.test(raw) ? raw : null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** "15.40" (h.mm, eRail) or "15h 40m" → minutes. */
function parseDuration(value?: string | number | null): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const raw = (value || "").toString().trim();
  const dotted = raw.match(/^(\d{1,3})[.](\d{2})$/);
  if (dotted) return Number(dotted[1]) * 60 + Number(dotted[2]);
  const spaced = raw.match(/^(\d{1,3})h\s*(\d{1,2})m?$/i);
  if (spaced) return Number(spaced[1]) * 60 + Number(spaced[2]);
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function matchesQuery(
  query: string,
  station: {
    stationCode?: string;
    stationName?: string;
    city?: string;
    state?: string;
  }
): boolean {
  const code = normalize(station.stationCode);
  if (code && code === query) return true;
  if (normalize(station.stationName).startsWith(query)) return true;
  const city = normalize(station.city);
  if (city && (city.startsWith(query) || city.includes(query))) return true;
  return false;
}

interface CtStation {
  stationCode?: string;
  stationName?: string;
  city?: string;
  state?: string;
  latitude?: string;
  longitude?: string;
}

/** Indian station autocomplete (validated so non-Indian queries come back empty). */
export async function suggestIndiaStations(query: string, limit = 5): Promise<StationSuggestion[]> {
  const q = normalize(query);
  if (q.length < 2) return [];

  const url =
    `${CT_HOST}/api/v2/trains/stations/auto-suggestion` +
    `?searchString=${encodeURIComponent(query.trim())}` +
    `&sourceStnCode=&popularStnListLimit=15&preferredStnListLimit=6&channel=mwebd&language=EN`;

  const res = await fetch(url, {
    headers: CT_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Indian station search returned ${res.status}`);

  const json = (await res.json()) as { data?: { stationList?: CtStation[] } };
  const list = json.data?.stationList ?? [];

  const out: StationSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const code = (s.stationCode || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    if (/all stations/i.test(s.stationName || "")) continue;
    if (!matchesQuery(q, s)) continue;
    seen.add(code);
    const lat = Number(s.latitude);
    const lng = Number(s.longitude);
    out.push({
      id: `IN:${code}`,
      name: `${(s.stationName || code).trim()} (${code})`,
      type: "station",
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Indian station code from a typed name or an `IN:CODE` id. */
export async function resolveIndiaStation(raw: string): Promise<string | null> {
  const value = raw.trim();
  if (!value) return null;
  if (value.toUpperCase().startsWith("IN:")) return value.slice(3).toUpperCase();
  if (/^[A-Za-z]{3,6}$/.test(value)) {
    const match = await suggestIndiaStations(value, 6);
    return match.find((s) => s.id === `IN:${value.toUpperCase()}`)?.id.slice(3) ?? null;
  }
  const match = await suggestIndiaStations(value, 1);
  return match[0]?.id.slice(3) ?? null;
}

interface CtTrain {
  trainNumber?: string;
  trainName?: string;
  departureTime?: string;
  arrivalTime?: string;
  duration?: number | string;
  distance?: number;
  runningDays?: string;
  trainType?: string;
  fromStnCode?: string;
  fromStnName?: string;
  toStnCode?: string;
  toStnName?: string;
  fromCityName?: string;
  toCityName?: string;
  avlClasses?: string[];
  availabilityCache?: Record<string, { fare?: string | number }>;
}

function cheapestFare(train: CtTrain): number | undefined {
  const cache = train.availabilityCache;
  if (!cache) return undefined;
  let best: number | undefined;
  for (const cls of train.avlClasses ?? Object.keys(cache)) {
    const fare = Number(cache[cls]?.fare);
    if (Number.isFinite(fare) && fare > 0 && (best === undefined || fare < best)) {
      best = fare;
    }
  }
  return best;
}

function buildJourney(params: {
  number: string;
  name: string;
  dep: string;
  arr: string;
  durationMin: number;
  from: string;
  to: string;
  date: string;
  product: string;
  price?: number;
  currency?: string;
}): TrainJourney | null {
  const departAt = `${params.date} ${params.dep}`;
  const arriveAt =
    arrivalStamp(params.date, params.dep, params.durationMin) || `${params.date} ${params.arr}`;
  const legs: TrainLeg[] = [
    {
      kind: "ride",
      line: `${params.number} · ${params.name}`.trim(),
      product: params.product,
      operator: params.name,
      direction: params.to,
      from: params.from,
      to: params.to,
      depart: departAt,
      arrive: arriveAt,
      durationMin: params.durationMin,
    },
  ];

  return {
    departAt,
    arriveAt,
    durationMin: params.durationMin,
    transfers: 0,
    from: params.from,
    to: params.to,
    price: params.price,
    currency: params.currency,
    legs,
  };
}

async function confirmTktTrains(
  fromCode: string,
  toCode: string,
  date: string
): Promise<TrainJourney[]> {
  const [dd, mm, yyyy] = [date.slice(8, 10), date.slice(5, 7), date.slice(0, 4)];
  const url =
    `${CT_HOST}/api/v1/trains/search` +
    `?sourceStationCode=${encodeURIComponent(fromCode)}` +
    `&destinationStationCode=${encodeURIComponent(toCode)}` +
    `&dateOfJourney=${dd}-${mm}-${yyyy}`;

  const res = await fetch(url, {
    headers: CT_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ConfirmTkt search returned ${res.status}`);

  const json = (await res.json()) as {
    data?: { trainList?: CtTrain[] };
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(json.error.message);

  const list = json.data?.trainList ?? [];
  const out: TrainJourney[] = [];
  for (const t of list) {
    const number = (t.trainNumber || "").trim();
    const dep = normaliseClock(t.departureTime);
    const arr = normaliseClock(t.arrivalTime);
    if (!number || !dep || !arr) continue;
    let durationMin = parseDuration(t.duration);
    if (!durationMin) durationMin = clockDiff(dep, arr);
    const journey = buildJourney({
      number,
      name: (t.trainName || "").trim() || number,
      dep,
      arr,
      durationMin,
      from: `${(t.fromStnName || fromCode).trim()} (${(t.fromStnCode || fromCode).trim()})`,
      to: `${(t.toStnName || toCode).trim()} (${(t.toStnCode || toCode).trim()})`,
      date,
      product: "Express",
      price: cheapestFare(t),
      currency: cheapestFare(t) ? "INR" : undefined,
    });
    if (journey) out.push(journey);
  }
  return out;
}

async function erailTrains(
  fromCode: string,
  toCode: string,
  date: string
): Promise<TrainJourney[]> {
  const url =
    `${ERAIL_HOST}/rail/getTrains.aspx?Station_From=${encodeURIComponent(fromCode)}` +
    `&Station_To=${encodeURIComponent(toCode)}&DataSource=0&Language=0&Cache=true`;

  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`eRail returned ${res.status}`);

  const body = await res.text();
  const head = body.slice(0, 300);
  if (/Please try again after some time/i.test(head)) throw new Error("eRail is busy right now");
  if (/From station not found/i.test(head))
    throw new Error(`eRail does not know station ${fromCode}`);
  if (/To station not found/i.test(head)) throw new Error(`eRail does not know station ${toCode}`);
  if (/No direct trains found/i.test(head)) return [];

  const out: TrainJourney[] = [];
  for (const chunk of body.split("~^").slice(1)) {
    const f = chunk.split("~");
    const number = (f[0] ?? "").trim();
    if (!/^\d{4,6}$/.test(number)) continue;

    const dep = normaliseClock(f[10]);
    const arr = normaliseClock(f[11]);
    if (!dep || !arr) continue;

    let durationMin = parseDuration(f[12]);
    if (!durationMin) durationMin = clockDiff(dep, arr);

    const name = (f[1] ?? number).trim();
    const journey = buildJourney({
      number,
      name,
      dep,
      arr,
      durationMin,
      from: `${(f[6] ?? fromCode).trim()} (${(f[7] ?? fromCode).trim()})`,
      to: `${(f[8] ?? toCode).trim()} (${(f[9] ?? toCode).trim()})`,
      date,
      product: "Express",
    });
    if (journey) out.push(journey);
  }
  return out;
}

export interface IndiaTrainSearch {
  trains: TrainJourney[];
  provider: string;
}

/** Direct trains between two Indian stations for a date (ConfirmTkt → eRail). */
export async function searchIndiaTrains(
  fromCode: string,
  toCode: string,
  date: string
): Promise<IndiaTrainSearch> {
  if (fromCode.toUpperCase() === toCode.toUpperCase()) {
    throw new Error("Origin and destination are the same station.");
  }

  try {
    const trains = await confirmTktTrains(fromCode.toUpperCase(), toCode.toUpperCase(), date);
    if (trains.length > 0) {
      return { trains: byDeparture(trains), provider: "Indian Railways · ConfirmTkt" };
    }
  } catch (err) {
    console.warn("ConfirmTkt search failed:", err instanceof Error ? err.message : err);
  }

  const trains = await erailTrains(fromCode.toUpperCase(), toCode.toUpperCase(), date);
  return { trains: byDeparture(trains), provider: "Indian Railways · eRail" };
}

function byDeparture(trains: TrainJourney[]): TrainJourney[] {
  return [...trains].sort((a, b) => a.departAt.localeCompare(b.departAt));
}
