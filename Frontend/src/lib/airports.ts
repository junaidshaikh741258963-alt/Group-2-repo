import rawAirports from "@/data/airports.json";

/**
 * Local airport index (IATA codes, city, country) bundled from the open
 * airport-codes dataset so flight autocomplete and station resolution keep
 * working without any third-party key.
 */
export interface AirportSuggestion {
  id: string;
  title: string;
  subtitle?: string;
  type: string;
  code?: string;
  airports: { code: string; name: string; distance?: string }[];
}

interface LocalAirport {
  c: string;
  n: string;
  y?: string;
  k?: string;
  t?: number;
}

const AIRPORTS = rawAirports as LocalAirport[];

const COUNTRY_NAMES: Record<string, string> = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  PT: "Portugal",
  IE: "Ireland",
  CH: "Switzerland",
  AT: "Austria",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  CZ: "Czechia",
  GR: "Greece",
  TR: "Turkey",
  AE: "United Arab Emirates",
  QA: "Qatar",
  SA: "Saudi Arabia",
  EG: "Egypt",
  ZA: "South Africa",
  KE: "Kenya",
  NG: "Nigeria",
  MA: "Morocco",
  TH: "Thailand",
  SG: "Singapore",
  MY: "Malaysia",
  ID: "Indonesia",
  VN: "Vietnam",
  PH: "Philippines",
  CN: "China",
  JP: "Japan",
  KR: "South Korea",
  HK: "Hong Kong",
  TW: "Taiwan",
  AU: "Australia",
  NZ: "New Zealand",
  CA: "Canada",
  MX: "Mexico",
  BR: "Brazil",
  AR: "Argentina",
  CL: "Chile",
  CO: "Colombia",
  PE: "Peru",
  RU: "Russia",
  UA: "Ukraine",
  IL: "Israel",
  JO: "Jordan",
  LK: "Sri Lanka",
  NP: "Nepal",
  BD: "Bangladesh",
  PK: "Pakistan",
  KZ: "Kazakhstan",
  IS: "Iceland",
  LU: "Luxembourg",
  BE: "Belgium",
  HR: "Croatia",
  HU: "Hungary",
  RO: "Romania",
  BG: "Bulgaria",
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function countryLabel(code?: string): string {
  if (!code) return "";
  return COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase();
}

function score(q: string, ap: LocalAirport): number | null {
  const code = ap.c.toLowerCase();
  const city = normalize(ap.y || "");
  const name = normalize(ap.n);
  if (code === q) return 0;
  if (city && city.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (city && city.includes(q)) return 3;
  if (name.includes(q)) return 4;
  return null;
}

/** Ranked local matches for an airport/city query (code > city > name). */
export function searchLocalAirports(rawQuery: string, limit = 8): AirportSuggestion[] {
  const q = normalize(rawQuery);
  if (q.length < 2) return [];

  const scored: { ap: LocalAirport; score: number }[] = [];
  for (const ap of AIRPORTS) {
    const s = score(q, ap);
    if (s === null) continue;
    scored.push({ ap, score: s });
  }
  scored.sort(
    (a, b) => a.score - b.score || (a.ap.t ?? 0) - (b.ap.t ?? 0) || a.ap.n.localeCompare(b.ap.n)
  );

  return scored.slice(0, limit).map(({ ap }) => ({
    id: `local:${ap.c}`,
    title: ap.n,
    subtitle: [ap.y, countryLabel(ap.k)].filter(Boolean).join(", ") || undefined,
    type: "airport",
    code: ap.c,
    airports: [{ code: ap.c, name: ap.n }],
  }));
}

/** Best-effort airport code for a typed city/airport name. */
export function resolveLocalAirport(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
  const [first] = searchLocalAirports(value, 1);
  return first?.airports[0]?.code ?? null;
}
