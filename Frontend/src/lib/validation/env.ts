/**
 * Environment validation (zod) — run once per server process.
 *
 * Philosophy: TripCraft runs fully keyless, so every provider key is OPTIONAL
 * by design. Validation therefore does two jobs:
 *   1. Type-check / coerce every env var the server reads (typos like
 *      `TIMEOUT_OSM_MS=abc` surface immediately instead of silently using a
 *      default), and
 *   2. With `STRICT_ENV=1` (CI, production) fail fast on malformed values.
 *      Without it (local dev) it logs a loud warning and keeps running.
 *
 * Missing keys never fail: they simply mean "that provider is off".
 */

import { z } from "zod";
import { log } from "@/server/log";

const blankToUndefined = (v: unknown) =>
  v === "" || v === undefined || v === null ? undefined : v;

const optStr = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());
const optUrl = z.preprocess(blankToUndefined, z.string().url().optional());
const optInt = z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  STRICT_ENV: optStr,

  // Chat AI — one OpenAI-compatible provider (Groq / Gemini / OpenAI / custom).
  // API_KEY + MODEL_NAME (+ optional BASE_URL) is the preferred trio.
  API_KEY: optStr,
  MODEL_NAME: optStr,
  BASE_URL: optUrl,
  AI_API_KEY: optStr,
  AI_MODEL: optStr,
  AI_BASE_URL: optUrl,
  // Legacy Gemini names — still honoured as a fallback.
  GEMINI_API_KEY: optStr,
  GEMINI_MODEL: optStr,
  OLLAMA_BASE_URL: optUrl,
  OLLAMA_MODEL: optStr,

  // Data providers
  RAPIDAPI_IMAGES_HOST: optStr,
  RAPIDAPI_IMAGES_KEY: optStr,
  HAFAS_BASE_URL: optUrl,
  HAFAS_TIMEZONE: optStr,

  // Persistence (optional MySQL; app falls back to localStorage-only)
  DB_HOST: optStr,
  DB_USER: optStr,
  DB_PASSWORD: z.string().optional(),
  DB_NAME: optStr,

  // Outbound budgets
  TIMEOUT_OVERPASS_MS: optInt,
  TIMEOUT_NOMINATIM_MS: optInt,
  TIMEOUT_OSRM_MS: optInt,
  TIMEOUT_IMAGE_MS: optInt,
  TIMEOUT_WEATHER_MS: optInt,
  TIMEOUT_FX_MS: optInt,
  TIMEOUT_QUEUE_WAIT_MS: optInt,
  RETRY_ATTEMPTS: optInt,
  RETRY_BASE_DELAY_MS: optInt,
  RETRY_MAX_DELAY_MS: optInt,
  BREAKER_FAILURE_THRESHOLD: optInt,
  BREAKER_COOLDOWN_MS: optInt,
  CONCURRENCY_OSM: optInt,
  CONCURRENCY_IMAGES: optInt,
  CONCURRENCY_DEFAULT: optInt,

  // Map tiles (public; validated for typos, consumed by the client)
  NEXT_PUBLIC_MAPTILE_PROVIDER: optStr,
  NEXT_PUBLIC_MAPTILE_URL: optStr,
  NEXT_PUBLIC_MAPTILE_ATTRIBUTION: optStr,
  NEXT_PUBLIC_MAPTILE_SUBDOMAINS: optStr,
  NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: optStr,
  NEXT_PUBLIC_MAPBOX_STYLE: optStr,
  NEXT_PUBLIC_CARTO_API_KEY: optStr,
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;
let issues: string[] = [];

/**
 * Validate `process.env` once. Returns the parsed values (unknown keys are
 * ignored). In strict mode a malformed value throws here — at first server
 * import — so bad deploys fail fast instead of degrading at runtime.
 */
export function validateEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (parsed.success) {
    cached = parsed.data;
    return cached;
  }

  issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  const strict = process.env.STRICT_ENV === "1" || process.env.STRICT_ENV === "true";
  if (strict) {
    throw new Error(`Invalid environment values (STRICT_ENV=1):\n- ${issues.join("\n- ")}`);
  }

  log.warn("[env] malformed environment value(s) ignored", { issues });
  // Keep running: every field has a safe fallback in the consuming module.
  cached = EnvSchema.parse({});
  return cached;
}

/** Issues from the most recent validation pass (empty when clean). */
export function envIssues(): string[] {
  validateEnv();
  return issues;
}
