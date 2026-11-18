/**
 * Guard for LAST-RESORT keyword photos (Pixabay / Pexels / Unsplash searched
 * with "<city> <category>"). Fuzzy keyword search happily returns the world's
 * most photogenic subjects: a "Pune hotel" query can land on the Taj Mahal
 * because that photo dominates the tag space. A placeholder is better than a
 * wrong landmark, so every candidate's own metadata (Pixabay tags, Pexels alt
 * text, Unsplash description) is checked against this table: if it names a
 * famous place from a DIFFERENT city than the query, the candidate is skipped
 * and the walk continues down the result list.
 *
 * Only lowercased text matching is used; entries cover the landmarks most
 * over-represented in stock-photo search results.
 */

interface GuardTerm {
  re: RegExp;
  city: string;
}

const GUARD_TERMS: GuardTerm[] = [
  { re: /\btaj mahal\b|\bagra\b|\bagra fort\b/, city: "agra" },
  { re: /\beiffel\b|\btrocad[ée]ro\b|\bnotre[- ]dame\b|\blouvre\b|\bsacr[ée][- ]c[œo]eur\b/, city: "paris" },
  { re: /\bcolosse?um\b|\btrevi fountain\b|\bspanish steps\b|\bpantheon\b/, city: "rome" },
  { re: /\bburj khalifa\b|\bburj al arab\b|\bdubai\b/, city: "dubai" },
  { re: /\bbig ben\b|\btower bridge\b|\bbuckingham\b|\blondon eye\b|\btower of london\b/, city: "london" },
  { re: /\bsagrada familia\b|\bpark g[üu]ell\b|\bcasa batll[óo]\b/, city: "barcelona" },
  { re: /\bmachu picchu\b|\bcusco\b|\bcuzco\b/, city: "cusco" },
  { re: /\bgolden temple\b|\bamritsar\b/, city: "amritsar" },
  { re: /\bgateway of india\b|\bmarine drive\b|\bchhatrapati shivaji\b|\bmumbai\b|\bbombay\b/, city: "mumbai" },
  { re: /\bindia gate\b|\bred fort\b|\bqutub minar\b|\bhumayun'?s tomb\b|\bnew delhi\b|\bdelhi\b/, city: "delhi" },
  { re: /\bhawa mahal\b|\bamber fort\b|\bjaipur\b/, city: "jaipur" },
  { re: /\bcharminar\b|\bhyderabad\b/, city: "hyderabad" },
  { re: /\bhowrah bridge\b|\bvictoria memorial\b|\bkolkata\b|\bcalcutta\b/, city: "kolkata" },
  { re: /\bmarina beach\b|\bchennai\b|\bmadras\b/, city: "chennai" },
  { re: /\bshaniwar wada\b|\bdagdusheth\b|\bpune\b|\bpoona\b/, city: "pune" },
  { re: /\bumaid bhawan\b|\bmehrangarh\b|\bjodhpur\b/, city: "jodhpur" },
  { re: /\btimes square\b|\bmanhattan\b|\bstatue of liberty\b|\bbrooklyn bridge\b|\bnew york\b|\bnyc\b/, city: "new york" },
  { re: /\bgolden gate\b|\bsan francisco\b/, city: "san francisco" },
  { re: /\bhollywood\b|\bvenice beach\b|\blos angeles\b/, city: "los angeles" },
  { re: /\bcolosseo\b|\bvenice canal\b|\bgrand canal\b|\bvenezia\b/, city: "venice" },
  { re: /\bsantorini\b|\boia\b|\bfira\b/, city: "santorini" },
  { re: /\bmatterhorn\b|\bzermatt\b/, city: "zermatt" },
  { re: /\bneuschwanstein\b/, city: "f[üu]ssen" },
  { re: /\bbrandenburg\b|\breichstag\b|\bberlin\b/, city: "berlin" },
  { re: /\bcheckpoint charlie\b/, city: "berlin" },
  { re: /\bpetronas\b|\bkuala lumpur\b/, city: "kuala lumpur" },
  { re: /\bmarina bay sands\b|\bsingapore\b/, city: "singapore" },
  { re: /\beverest\b|\bkatmandu\b|\bkathmandu\b/, city: "kathmandu" },
  { re: /\bpyramids?\b|\bgiza\b|\bsphinx\b/, city: "giza" },
  { re: /\bchrist the redeemer\b|\bcopacabana\b|\brio de janeiro\b/, city: "rio de janeiro" },
  { re: /\biguazu\b|\bigua[çc]u\b/, city: "foz do iguaçu" },
  { re: /\bthai temple\b|\bwat pho\b|\bgrand palace\b|\bbangkok\b/, city: "bangkok" },
  { re: /\bhalong\b|\bh[aạ] long\b/, city: "ha long" },
  { re: /\bcappadocia\b|\bistanbul\b|\bhagia sophia\b|\bblue mosque\b/, city: "istanbul" },
];

/** Regex-escape a city name for the "same city" exemption check. */
function cityMatches(city: string, termCity: string): boolean {
  if (!termCity) return true;
  const c = city.trim().toLowerCase();
  if (!c) return false;
  return c.includes(termCity) || termCity.includes(c);
}

/**
 * True when the metadata text names a famous place that is NOT the query
 * city — the candidate must be skipped (try the next result instead).
 */
export function mentionsOtherPlace(text: string | undefined, city: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const term of GUARD_TERMS) {
    if (!term.re.test(lower)) continue;
    if (cityMatches(city, term.city)) continue;
    return true;
  }
  return false;
}
