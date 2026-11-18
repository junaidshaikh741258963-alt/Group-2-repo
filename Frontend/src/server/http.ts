/**
 * HTTP + provider execution primitives:
 *  - timeouts on every outbound call
 *  - bounded retry with exponential backoff + jitter (429 / 5xx / network)
 *  - Retry-After support for 429
 *  - circuit breaker + per-provider concurrency slot
 *
 * All external traffic in the app should go through `runWithProvider` +
 * `fetchJson` so behaviour is uniform across routes.
 */

import { config, type ProviderName } from "./config";
import { canPass, recordFailure, recordSuccess, CircuitOpenError } from "./breaker";
import { withSlot } from "./queue";

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public url: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof CircuitOpenError) return false;
  // Abort/timeout/socket errors are transient.
  return true;
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, config.retry.maxDelayMs);
  const exp = config.retry.baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * 200;
  return Math.min(config.retry.maxDelayMs, exp + jitter);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions {
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Total attempts (default from config). Set 1 to disable retries. */
  attempts?: number;
  signal?: AbortSignal;
}

/** JSON fetch with timeout and bounded exponential backoff. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? config.retry.attempts);
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal,
      });

      if (!res.ok) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        // Drain the body so the connection can be reused; content is not read.
        await res.text().catch(() => "");
        const err = new HttpError(
          `HTTP ${res.status} from ${safeUrl(url)}`,
          res.status,
          url,
          retryAfterMs
        );
        if (attempt < attempts - 1 && isRetryable(err)) {
          await sleep(backoffMs(attempt, retryAfterMs));
          lastErr = err;
          continue;
        }
        throw err;
      }

      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && !(err.status === 429 || err.status >= 500)) throw err;
      if (attempt < attempts - 1 && isRetryable(err)) {
        const retryAfter = err instanceof HttpError ? err.retryAfterMs : undefined;
        await sleep(backoffMs(attempt, retryAfter));
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

/** Never leak query keys (api_key etc.) in error messages/logs. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = u.search
      .split("&")
      .filter((p) => !/api_key|key|token|access_token/i.test(p))
      .join("&");
    return u.toString();
  } catch {
    return url.split("?")[0];
  }
}

const LIMITS: Partial<Record<ProviderName, number>> = {
  overpass: config.concurrency.osm,
  nominatim: config.concurrency.osm,
  osrm: config.concurrency.osm,
  images: config.concurrency.images,
};

function isUpstreamFailure(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof Error && err.message === "queue wait timeout") return false;
  return true;
}

/**
 * Run an external call under the provider's circuit breaker + concurrency slot.
 * Throws `CircuitOpenError` fast when the provider is unhealthy so callers can
 * fall back to their next data source.
 */
export async function runWithProvider<T>(
  provider: ProviderName,
  fn: () => Promise<T>,
  limit?: number
): Promise<T> {
  if (!canPass(provider)) throw new CircuitOpenError(provider);

  try {
    const result = await withSlot(
      provider,
      limit ?? LIMITS[provider] ?? config.concurrency.default,
      config.timeouts.acquire,
      fn
    );
    recordSuccess(provider);
    return result;
  } catch (err) {
    if (isUpstreamFailure(err)) recordFailure(provider);
    throw err;
  }
}

export { CircuitOpenError };
