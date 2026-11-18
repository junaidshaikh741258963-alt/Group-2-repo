/**
 * Central server configuration.
 *
 * Every API key / endpoint / timeout / TTL used by the server lives here and is
 * read from `.env.local` (see `.env.example` for the expected names). Nothing in
 * the codebase should read `process.env` for third-party services directly.
 */

import { validateEnv } from "@/lib/validation/env";

// One validation pass per process: malformed values are reported loudly here
// (or throw when STRICT_ENV=1). All keys stay optional — the app is keyless-first.
validateEnv();

const str = (v?: string): string | null => (v && v.trim() ? v.trim() : null);
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  /** API keys — all sourced from .env.local. */
  keys: {
    /**
     * Chat provider credential. `API_KEY` is the preferred generic name;
     * `AI_API_KEY` and the legacy `GEMINI_API_KEY` still work.
     */
    get llm(): string | null {
      return (
        str(process.env.API_KEY) ?? str(process.env.AI_API_KEY) ?? str(process.env.GEMINI_API_KEY)
      );
    },
    get rapidImagesHost(): string | null {
      return str(process.env.RAPIDAPI_IMAGES_HOST);
    },
    get rapidImagesKey(): string | null {
      return str(process.env.RAPIDAPI_IMAGES_KEY);
    },
  },

  /** Per-request timeouts (ms). */
  timeouts: {
    overpass: num(process.env.TIMEOUT_OVERPASS_MS, 12_000),
    nominatim: num(process.env.TIMEOUT_NOMINATIM_MS, 8_000),
    osrm: num(process.env.TIMEOUT_OSRM_MS, 10_000),
    imageSource: num(process.env.TIMEOUT_IMAGE_MS, 7_000),
    weather: num(process.env.TIMEOUT_WEATHER_MS, 8_000),
    fx: num(process.env.TIMEOUT_FX_MS, 6_000),
    acquire: num(process.env.TIMEOUT_QUEUE_WAIT_MS, 15_000),
  },

  /** Cache TTLs (ms) per data domain. */
  ttl: {
    hotels: 10 * 60_000,
    places: 5 * 60_000,
    flights: 10 * 60_000,
    airport: 24 * 3_600_000,
    images: 30 * 60_000,
    placePhotos: 15 * 60_000,
    hotelPhotos: 30 * 60_000,
    hotelReviews: 6 * 3_600_000,
    hotelToken: 24 * 3_600_000,
    geocode: 24 * 3_600_000,
    weather: 3_600_000,
    fx: 12 * 3_600_000,
    /** Negative results (empty / not found) are cached briefly to avoid hammering. */
    negative: 60_000,
  },

  /** Concurrency limits per external provider. */
  concurrency: {
    osm: num(process.env.CONCURRENCY_OSM, 4),
    images: num(process.env.CONCURRENCY_IMAGES, 6),
    default: num(process.env.CONCURRENCY_DEFAULT, 8),
  },

  /** Circuit breaker: trip after N consecutive failures, cool down before a probe. */
  breaker: {
    failureThreshold: num(process.env.BREAKER_FAILURE_THRESHOLD, 5),
    cooldownMs: num(process.env.BREAKER_COOLDOWN_MS, 30_000),
  },

  /** Retry policy for transient failures (429 / 5xx / network). */
  retry: {
    attempts: num(process.env.RETRY_ATTEMPTS, 3),
    baseDelayMs: num(process.env.RETRY_BASE_DELAY_MS, 400),
    maxDelayMs: num(process.env.RETRY_MAX_DELAY_MS, 4_000),
  },
} as const;

export type ProviderName = "overpass" | "nominatim" | "osrm" | "images" | "weather" | "fx" | "llm";
