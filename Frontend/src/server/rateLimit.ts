/**
 * In-process rate limiting for expensive API routes.
 *
 * Fixed-window counters per route+client — enough to stop accidental hammering
 * of metered providers (RapidAPI, Groq) from one browser, without a Redis
 * dependency. Behind a proxy the client IP comes from x-forwarded-for;
 * otherwise everything shares the "local" bucket, which is the honest choice
 * for a single-user dev machine.
 */

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface RateLimitOk {
  ok: true;
  remaining: number;
}

export interface RateLimitBlocked {
  ok: false;
  retryAfterSec: number;
}

export type RateLimitResult = RateLimitOk | RateLimitBlocked;

interface Window {
  start: number;
  count: number;
}

const windows = new Map<string, Window>();
const MAX_KEYS = 5_000;

/** Test/ops hook. */
export function resetRateLimits(): void {
  windows.clear();
}

export function rateLimit(
  key: string,
  options: RateLimitOptions,
  now: number = Date.now()
): RateLimitResult {
  const w = windows.get(key);
  if (!w || now - w.start >= options.windowMs) {
    if (windows.size >= MAX_KEYS) prune(now);
    windows.set(key, { start: now, count: 1 });
    return { ok: true, remaining: options.limit - 1 };
  }
  if (w.count >= options.limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((w.start + options.windowMs - now) / 1000)),
    };
  }
  w.count += 1;
  return { ok: true, remaining: options.limit - w.count };
}

/** Drop windows that are long expired (crude but keeps memory bounded). */
function prune(now: number): void {
  for (const [key, w] of windows) {
    if (now - w.start > 10 * 60_000) windows.delete(key);
  }
  // Still full (pathological): clear the oldest half.
  if (windows.size >= MAX_KEYS) {
    const keys = [...windows.keys()].slice(0, Math.floor(MAX_KEYS / 2));
    for (const k of keys) windows.delete(k);
  }
}

/** Best-effort client identity for bucket keys. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first.slice(0, 45);
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 45);
  return "local";
}

export interface EnforceOptions extends RateLimitOptions {
  /** Bucket namespace; defaults to "api". */
  scope?: string;
}

/**
 * Check a request against its bucket. Returns a ready 429 Response when
 * blocked, or null when the request may proceed.
 */
export function enforceRateLimit(req: Request, options: EnforceOptions): Response | null {
  const scope = options.scope ?? "api";
  const result = rateLimit(`${scope}:${clientKey(req)}`, options);
  if (result.ok) return null;
  return Response.json(
    { error: "Too many requests — please wait a moment and try again." },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSec),
        "Cache-Control": "no-store",
      },
    }
  );
}
