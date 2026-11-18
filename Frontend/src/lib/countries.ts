/**
 * Country index for the route planner.
 *
 * The picker needs names + flags only; `code` is the ISO 3166-1 alpha-2 value
 * Nominatim expects in `countrycodes`, which is what keeps the From/To
 * suggestions inside the country the user picked.
 */

export interface Country {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  flag: string;
}

export const COUNTRIES: Country[] = [
  { code: "af", name: "Afghanistan", flag: "🇦🇫" },
  { code: "al", name: "Albania", flag: "🇦🇱" },
  { code: "dz", name: "Algeria", flag: "🇩🇿" },
  { code: "ao", name: "Angola", flag: "🇦🇴" },
  { code: "ar", name: "Argentina", flag: "🇦🇷" },
  { code: "am", name: "Armenia", flag: "🇦🇲" },
  { code: "au", name: "Australia", flag: "🇦🇺" },
  { code: "at", name: "Austria", flag: "🇦🇹" },
  { code: "az", name: "Azerbaijan", flag: "🇦🇿" },
  { code: "bs", name: "Bahamas", flag: "🇧🇸" },
  { code: "bh", name: "Bahrain", flag: "🇧🇭" },
  { code: "bd", name: "Bangladesh", flag: "🇧🇩" },
  { code: "by", name: "Belarus", flag: "🇧🇾" },
  { code: "be", name: "Belgium", flag: "🇧🇪" },
  { code: "bz", name: "Belize", flag: "🇧🇿" },
  { code: "bo", name: "Bolivia", flag: "🇧🇴" },
  { code: "ba", name: "Bosnia and Herzegovina", flag: "🇧🇦" },
  { code: "br", name: "Brazil", flag: "🇧🇷" },
  { code: "bg", name: "Bulgaria", flag: "🇧🇬" },
  { code: "kh", name: "Cambodia", flag: "🇰🇭" },
  { code: "cm", name: "Cameroon", flag: "🇨🇲" },
  { code: "ca", name: "Canada", flag: "🇨🇦" },
  { code: "cl", name: "Chile", flag: "🇨🇱" },
  { code: "cn", name: "China", flag: "🇨🇳" },
  { code: "co", name: "Colombia", flag: "🇨🇴" },
  { code: "cr", name: "Costa Rica", flag: "🇨🇷" },
  { code: "hr", name: "Croatia", flag: "🇭🇷" },
  { code: "cu", name: "Cuba", flag: "🇨🇺" },
  { code: "cy", name: "Cyprus", flag: "🇨🇾" },
  { code: "cz", name: "Czechia", flag: "🇨🇿" },
  { code: "dk", name: "Denmark", flag: "🇩🇰" },
  { code: "do", name: "Dominican Republic", flag: "🇩🇴" },
  { code: "ec", name: "Ecuador", flag: "🇪🇨" },
  { code: "eg", name: "Egypt", flag: "🇪🇬" },
  { code: "ee", name: "Estonia", flag: "🇪🇪" },
  { code: "et", name: "Ethiopia", flag: "🇪🇹" },
  { code: "fi", name: "Finland", flag: "🇫🇮" },
  { code: "fr", name: "France", flag: "🇫🇷" },
  { code: "ge", name: "Georgia", flag: "🇬🇪" },
  { code: "de", name: "Germany", flag: "🇩🇪" },
  { code: "gh", name: "Ghana", flag: "🇬🇭" },
  { code: "gr", name: "Greece", flag: "🇬🇷" },
  { code: "gt", name: "Guatemala", flag: "🇬🇹" },
  { code: "hk", name: "Hong Kong", flag: "🇭🇰" },
  { code: "hu", name: "Hungary", flag: "🇭🇺" },
  { code: "is", name: "Iceland", flag: "🇮🇸" },
  { code: "in", name: "India", flag: "🇮🇳" },
  { code: "id", name: "Indonesia", flag: "🇮🇩" },
  { code: "ir", name: "Iran", flag: "🇮🇷" },
  { code: "iq", name: "Iraq", flag: "🇮🇶" },
  { code: "ie", name: "Ireland", flag: "🇮🇪" },
  { code: "il", name: "Israel", flag: "🇮🇱" },
  { code: "it", name: "Italy", flag: "🇮🇹" },
  { code: "ci", name: "Ivory Coast", flag: "🇨🇮" },
  { code: "jm", name: "Jamaica", flag: "🇯🇲" },
  { code: "jp", name: "Japan", flag: "🇯🇵" },
  { code: "jo", name: "Jordan", flag: "🇯🇴" },
  { code: "kz", name: "Kazakhstan", flag: "🇰🇿" },
  { code: "ke", name: "Kenya", flag: "🇰🇪" },
  { code: "kr", name: "South Korea", flag: "🇰🇷" },
  { code: "kw", name: "Kuwait", flag: "🇰🇼" },
  { code: "lv", name: "Latvia", flag: "🇱🇻" },
  { code: "lb", name: "Lebanon", flag: "🇱🇧" },
  { code: "lt", name: "Lithuania", flag: "🇱🇹" },
  { code: "lu", name: "Luxembourg", flag: "🇱🇺" },
  { code: "mo", name: "Macau", flag: "🇲🇴" },
  { code: "my", name: "Malaysia", flag: "🇲🇾" },
  { code: "mv", name: "Maldives", flag: "🇲🇻" },
  { code: "mt", name: "Malta", flag: "🇲🇹" },
  { code: "mx", name: "Mexico", flag: "🇲🇽" },
  { code: "md", name: "Moldova", flag: "🇲🇩" },
  { code: "mn", name: "Mongolia", flag: "🇲🇳" },
  { code: "me", name: "Montenegro", flag: "🇲🇪" },
  { code: "ma", name: "Morocco", flag: "🇲🇦" },
  { code: "mm", name: "Myanmar", flag: "🇲🇲" },
  { code: "np", name: "Nepal", flag: "🇳🇵" },
  { code: "nl", name: "Netherlands", flag: "🇳🇱" },
  { code: "nz", name: "New Zealand", flag: "🇳🇿" },
  { code: "ni", name: "Nicaragua", flag: "🇳🇮" },
  { code: "ng", name: "Nigeria", flag: "🇳🇬" },
  { code: "mk", name: "North Macedonia", flag: "🇲🇰" },
  { code: "no", name: "Norway", flag: "🇳🇴" },
  { code: "om", name: "Oman", flag: "🇴🇲" },
  { code: "pk", name: "Pakistan", flag: "🇵🇰" },
  { code: "pa", name: "Panama", flag: "🇵🇦" },
  { code: "py", name: "Paraguay", flag: "🇵🇾" },
  { code: "pe", name: "Peru", flag: "🇵🇪" },
  { code: "ph", name: "Philippines", flag: "🇵🇭" },
  { code: "pl", name: "Poland", flag: "🇵🇱" },
  { code: "pt", name: "Portugal", flag: "🇵🇹" },
  { code: "qa", name: "Qatar", flag: "🇶🇦" },
  { code: "ro", name: "Romania", flag: "🇷🇴" },
  { code: "ru", name: "Russia", flag: "🇷🇺" },
  { code: "sa", name: "Saudi Arabia", flag: "🇸🇦" },
  { code: "rs", name: "Serbia", flag: "🇷🇸" },
  { code: "sg", name: "Singapore", flag: "🇸🇬" },
  { code: "sk", name: "Slovakia", flag: "🇸🇰" },
  { code: "si", name: "Slovenia", flag: "🇸🇮" },
  { code: "za", name: "South Africa", flag: "🇿🇦" },
  { code: "es", name: "Spain", flag: "🇪🇸" },
  { code: "lk", name: "Sri Lanka", flag: "🇱🇰" },
  { code: "se", name: "Sweden", flag: "🇸🇪" },
  { code: "ch", name: "Switzerland", flag: "🇨🇭" },
  { code: "tw", name: "Taiwan", flag: "🇹🇼" },
  { code: "tz", name: "Tanzania", flag: "🇹🇿" },
  { code: "th", name: "Thailand", flag: "🇹🇭" },
  { code: "tn", name: "Tunisia", flag: "🇹🇳" },
  { code: "tr", name: "Türkiye", flag: "🇹🇷" },
  { code: "ug", name: "Uganda", flag: "🇺🇬" },
  { code: "ua", name: "Ukraine", flag: "🇺🇦" },
  { code: "ae", name: "United Arab Emirates", flag: "🇦🇪" },
  { code: "gb", name: "United Kingdom", flag: "🇬🇧" },
  { code: "us", name: "United States", flag: "🇺🇸" },
  { code: "uy", name: "Uruguay", flag: "🇺🇾" },
  { code: "uz", name: "Uzbekistan", flag: "🇺🇿" },
  { code: "ve", name: "Venezuela", flag: "🇻🇪" },
  { code: "vn", name: "Vietnam", flag: "🇻🇳" },
  { code: "zm", name: "Zambia", flag: "🇿🇲" },
  { code: "zw", name: "Zimbabwe", flag: "🇿🇼" },
];

/** Shown before the user types — the places people actually route between. */
const POPULAR_CODES = [
  "us",
  "gb",
  "fr",
  "it",
  "es",
  "pt",
  "de",
  "gr",
  "tr",
  "ae",
  "in",
  "th",
  "jp",
  "id",
  "mx",
  "ca",
  "au",
  "za",
];

export const POPULAR_COUNTRIES: Country[] = POPULAR_CODES.flatMap((code) => {
  const hit = COUNTRIES.find((c) => c.code === code);
  return hit ? [hit] : [];
});

/** Case-insensitive lookup — matches on name or ISO code. */
export function searchCountries(query: string, limit = 8): Country[] {
  const q = query.trim().toLowerCase();
  if (!q) return POPULAR_COUNTRIES.slice(0, limit);
  const starts: Country[] = [];
  const contains: Country[] = [];
  for (const c of COUNTRIES) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q) || c.code === q) starts.push(c);
    else if (name.includes(q)) contains.push(c);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
