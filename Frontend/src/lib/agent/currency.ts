export interface CurrencyRate {
  from: string;
  to: string;
  rate: number;
  date: string;
}

/** Best-guess local currency code for a destination (country-to-country pricing). */
export function detectLocalCurrency(destination: string): string {
  const d = (destination || "").toLowerCase();
  if (d.includes("japan") || d.includes("tokyo")) return "JPY";
  if (
    d.includes("europe") ||
    d.includes("paris") ||
    d.includes("rome") ||
    d.includes("berlin") ||
    d.includes("barcelona") ||
    d.includes("amsterdam")
  )
    return "EUR";
  if (d.includes("uk") || d.includes("london")) return "GBP";
  if (d.includes("india") || d.includes("delhi") || d.includes("mumbai")) return "INR";
  if (d.includes("thailand") || d.includes("bangkok")) return "THB";
  if (d.includes("china") || d.includes("beijing")) return "CNY";
  if (d.includes("korea") || d.includes("seoul")) return "KRW";
  if (d.includes("brazil") || d.includes("rio")) return "BRL";
  if (d.includes("mexico") || d.includes("cancun")) return "MXN";
  if (d.includes("australia") || d.includes("sydney")) return "AUD";
  if (d.includes("canada") || d.includes("toronto")) return "CAD";
  if (d.includes("singapore")) return "SGD";
  if (d.includes("malaysia") || d.includes("kuala")) return "MYR";
  if (d.includes("uae") || d.includes("dubai")) return "AED";
  if (d.includes("turkey") || d.includes("istanbul")) return "TRY";
  if (d.includes("switzerland") || d.includes("zurich")) return "CHF";
  if (d.includes("sweden") || d.includes("stockholm")) return "SEK";
  if (d.includes("norway") || d.includes("oslo")) return "NOK";
  if (d.includes("denmark") || d.includes("copenhagen")) return "DKK";
  if (d.includes("poland") || d.includes("warsaw")) return "PLN";
  if (d.includes("egypt") || d.includes("cairo")) return "EGP";
  if (d.includes("south africa") || d.includes("cape town")) return "ZAR";
  if (d.includes("indonesia") || d.includes("bali")) return "IDR";
  if (d.includes("vietnam") || d.includes("hanoi")) return "VND";
  if (d.includes("philippines") || d.includes("manila")) return "PHP";
  return "USD";
}

let cachedRates: Record<string, number> | null = null;
let cacheBase = "";
let cacheDate = "";

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  INR: "₹",
  KRW: "₩",
  THB: "฿",
  VND: "₫",
  MXN: "Mex$",
  BRL: "R$",
  CAD: "C$",
  AUD: "A$",
  CHF: "CHF",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  PLN: "zł",
  CZK: "Kč",
  HUF: "Ft",
  TRY: "₺",
  RUB: "₽",
  SAR: "SAR",
  AED: "AED",
  SGD: "S$",
  MYR: "RM",
  PHP: "₱",
  IDR: "Rp",
  NZD: "NZ$",
  ZAR: "R",
  EGP: "E£",
};

/** Sync symbol lookup (ISO code → display symbol). */
export function currencySymbol(currencyCode: string): string {
  return SYMBOLS[currencyCode.toUpperCase()] || currencyCode.toUpperCase();
}

/** Exchange rate for `code` against USD: live rates when cached, else fallbacks. */
export function rateFor(code: string): number {
  const live = cacheBase === "USD" ? cachedRates?.[code] : undefined;
  if (typeof live === "number" && live > 0) return live;
  const fallback = getFallbackRates("USD")[code];
  return typeof fallback === "number" && fallback > 0 ? fallback : 1;
}

/** Convert a USD amount into `code` using the best rate available right now. */
export function usdTo(amountUsd: number, code: string): number {
  return Math.round(amountUsd * rateFor(code));
}

/** Human-readable money for a USD amount rendered in the trip currency. */
export function formatAmount(amountUsd: number, code: string): string {
  const value = usdTo(amountUsd, code);
  const symbol = currencySymbol(code);
  const text = value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return symbol === code ? `${code} ${text}` : `${symbol}${text}`;
}

/**
 * Budget currency derived from the trip's source and destination:
 * origin (home) first, then the destination's local currency, then USD.
 */
export function tripCurrencyFor(
  origin: string,
  destination: string
): {
  code: string;
  options: string[];
} {
  const options: string[] = [];
  const push = (code?: string) => {
    if (code && !options.includes(code)) options.push(code);
  };
  if (origin?.trim()) push(detectLocalCurrency(origin));
  if (destination?.trim()) push(detectLocalCurrency(destination));
  push("USD");
  return { code: options[0], options: options.slice(0, 3) };
}

export async function getExchangeRates(
  baseCurrency: string = "USD"
): Promise<Record<string, number>> {
  const today = new Date().toISOString().split("T")[0];

  if (cachedRates && cacheDate === today && cacheBase === baseCurrency) {
    return cachedRates;
  }

  try {
    // frankfurter.app - completely free, no API key needed
    const res = await fetch(`https://api.frankfurter.app/latest?from=${baseCurrency}`);
    if (!res.ok) throw new Error("Failed to fetch rates");
    const data = await res.json();
    const rates: Record<string, number> = { [baseCurrency]: 1, ...data.rates };
    cachedRates = rates;
    cacheBase = baseCurrency;
    cacheDate = today;
    return rates;
  } catch {
    // Fallback: try exchangerate-api (free tier)
    try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${baseCurrency}`);
      if (!res.ok) throw new Error("rates unavailable");
      const data = await res.json();
      const rates: Record<string, number> = data.rates || getFallbackRates(baseCurrency);
      cachedRates = rates;
      cacheBase = baseCurrency;
      cacheDate = today;
      return rates;
    } catch {
      const rates = getFallbackRates(baseCurrency);
      cachedRates = rates;
      cacheBase = baseCurrency;
      cacheDate = today;
      return rates;
    }
  }
}

export async function convertCurrency(
  amount: number,
  from: string,
  to: string
): Promise<{ amount: number; rate: number; result: number }> {
  const rates = await getExchangeRates(from);
  const rate = rates[to] || 1;
  return { amount, rate, result: Math.round(amount * rate * 100) / 100 };
}

export async function getCurrencySymbol(currencyCode: string): Promise<string> {
  return currencySymbol(currencyCode);
}

function getFallbackRates(base: string): Record<string, number> {
  const baselines: Record<string, Record<string, number>> = {
    USD: {
      EUR: 0.92,
      GBP: 0.79,
      JPY: 149.5,
      INR: 83.1,
      THB: 35.8,
      MXN: 17.2,
      BRL: 4.97,
      CAD: 1.36,
      AUD: 1.53,
      KRW: 1325,
      CNY: 7.24,
      SGD: 1.34,
      MYR: 4.72,
      PHP: 56.2,
      IDR: 15450,
      VND: 24350,
      AED: 3.67,
      SAR: 3.75,
      TRY: 34,
      CHF: 0.88,
      SEK: 10.5,
      NOK: 10.7,
      DKK: 6.9,
      PLN: 4.0,
      CZK: 23,
      HUF: 360,
      RUB: 92,
      NZD: 1.65,
      ZAR: 18,
      EGP: 48,
    },
    EUR: { USD: 1.09, GBP: 0.86, JPY: 162.5, INR: 90.3, THB: 38.9 },
  };
  return baselines[base] || baselines["USD"];
}
