/**
 * Shared TTL cache + in-flight request deduplication (single-flight).
 *
 * - `cache.wrap()` returns a fresh value when cached, otherwise runs the loader
 *   exactly once even if N callers ask for the same key at the same time.
 * - On loader failure the last stale value (if any) is served so one failing
 *   upstream never empties a working UI.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
  staleUntil: number;
}

export class TTLCache {
  private store = new Map<string, Entry>();

  constructor(private maxEntries = 600) {}

  private touch(key: string, entry: Entry) {
    // LRU: re-insert so the oldest keys are evicted first.
    this.store.delete(key);
    this.store.set(key, entry);
  }

  getFresh<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    this.touch(key, e);
    return e.value as T;
  }

  /** Value that is past TTL but still usable as a fallback when the upstream fails. */
  getStale<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.staleUntil) return undefined;
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number, staleMs = ttlMs * 6): void {
    const now = Date.now();
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: now + ttlMs, staleUntil: now + ttlMs + staleMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** Process-wide cache shared by every route handler. */
export const apiCache = new TTLCache(800);

const inflight = new Map<string, Promise<unknown>>();

/**
 * Run `loader` once per key: concurrent callers share the same promise, so an
 * identical request never fans out into duplicate upstream calls.
 */
export function singleFlight<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => loader())().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export interface WrapOptions {
  ttlMs: number;
  /** Reuse the last value for this long past TTL when the loader fails. */
  staleMs?: number;
  /** Skip the cache entirely (explicit "retry" action from the UI). */
  force?: boolean;
  /** Positive results only — set false to also cache empty/negative results briefly. */
  cacheEmpty?: boolean;
}

function isEmptyResult(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(v)) {
      const item = v[k];
      if (Array.isArray(item)) return item.length === 0;
    }
  }
  return false;
}

/**
 * Cached + de-duplicated loader.
 * Falls back to stale data if the loader throws after the value expired.
 */
export async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  opts: WrapOptions
): Promise<T> {
  if (!opts.force) {
    const fresh = apiCache.getFresh<T>(key);
    if (fresh !== undefined) return fresh;
  }

  const run = async (): Promise<T> => {
    try {
      const value = await loader();
      const empty = isEmptyResult(value);
      const ttl = opts.cacheEmpty === false && empty ? Math.min(opts.ttlMs, 60_000) : opts.ttlMs;
      apiCache.set(key, value, ttl, opts.staleMs);
      return value;
    } catch (err) {
      const stale = apiCache.getStale<T>(key);
      if (stale !== undefined) {
        console.warn(`[cache] serving stale for ${key}:`, err instanceof Error ? err.message : err);
        return stale;
      }
      throw err;
    }
  };

  return singleFlight(key, run);
}

/** Stable cache key from an object (sorted keys → order-independent). */
export function cacheKey(namespace: string, params: Record<string, unknown>): string {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k] ?? "")}`)
    .join("|");
  return `${namespace}::${parts}`;
}
