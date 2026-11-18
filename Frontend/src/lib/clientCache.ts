"use client";

/**
 * Tiny stale-while-revalidate fetch hook.
 *
 * Why not a library: the app needs exactly one behaviour — render cached data
 * instantly, refresh in the background, keep the last good value on failure.
 * Memory keeps it fast within a session; sessionStorage survives navigation;
 * nothing is shared across users.
 *
 * The fetcher is captured in a ref so callers can pass inline closures without
 * retriggering the request every render; `key` fully describes the request.
 */

import { useEffect, useRef, useState } from "react";

interface CacheEntry<T> {
  data: T;
  at: number;
}

const memory = new Map<string, CacheEntry<unknown>>();

export interface CachedFetchOptions {
  /** After this age the cached value is served but revalidated. Default 5 min. */
  ttlMs?: number;
  /** Persist across navigations ("session", default) or only in memory (false). */
  storage?: "session" | false;
}

export interface CachedFetchResult<T> {
  data: T | null;
  error: string | null;
  /** True only when there is nothing to show yet. */
  loading: boolean;
  /** True while a background refresh runs over stale data. */
  refreshing: boolean;
  refresh: () => void;
}

function storageKey(key: string): string {
  return `tripcraft_cache:${key}`;
}

function readCache<T>(key: string, storage: "session" | false): CacheEntry<T> | null {
  const mem = memory.get(key) as CacheEntry<T> | undefined;
  if (mem) return mem;
  if (storage === "session" && typeof window !== "undefined") {
    try {
      const raw = window.sessionStorage.getItem(storageKey(key));
      if (raw) {
        const parsed = JSON.parse(raw) as CacheEntry<T>;
        if (parsed && typeof parsed.at === "number") {
          memory.set(key, parsed as CacheEntry<unknown>);
          return parsed;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function writeCache<T>(key: string, data: T, storage: "session" | false): void {
  const entry: CacheEntry<T> = { data, at: Date.now() };
  memory.set(key, entry as CacheEntry<unknown>);
  if (storage === "session" && typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(storageKey(key), JSON.stringify(entry));
    } catch {
      /* quota */
    }
  }
}

export function useCachedFetch<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: CachedFetchOptions = {}
): CachedFetchResult<T> {
  const { ttlMs = 5 * 60_000, storage = "session" } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const initial = key ? readCache<T>(key, storage) : null;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    data: T | null;
    error: string | null;
    loading: boolean;
    refreshing: boolean;
  }>(() => ({
    key,
    data: initial?.data ?? null,
    error: null,
    loading: Boolean(key) && !initial,
    refreshing: Boolean(initial),
  }));

  // Different resource: reset state during render (no stale flash).
  if (state.key !== key) {
    const cached = key ? readCache<T>(key, storage) : null;
    setState({
      key,
      data: cached?.data ?? null,
      error: null,
      loading: Boolean(key) && !cached,
      refreshing: Boolean(cached),
    });
  }

  useEffect(() => {
    if (!key) return;
    const cached = readCache<T>(key, storage);
    if (cached && Date.now() - cached.at < ttlMs && nonce === 0) return;

    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      try {
        const data = await fetcherRef.current(ac.signal);
        if (cancelled) return;
        writeCache(key, data, storage);
        setState((prev) =>
          prev.key === key ? { ...prev, data, error: null, loading: false, refreshing: false } : prev
        );
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        setState((prev) =>
          prev.key === key
            ? {
                ...prev,
                error: e instanceof Error ? e.message : "Request failed",
                loading: false,
                refreshing: false,
              }
            : prev
        );
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [key, ttlMs, storage, nonce]);

  return {
    data: state.data,
    error: state.error,
    loading: state.key === key ? state.loading : true,
    refreshing: state.key === key ? state.refreshing : true,
    refresh: () => setNonce((n) => n + 1),
  };
}

/** Clear everything (used by tests and "fresh start" actions). */
export function clearClientCache(): void {
  memory.clear();
  if (typeof window !== "undefined") {
    try {
      for (const k of Object.keys(window.sessionStorage)) {
        if (k.startsWith("tripcraft_cache:")) window.sessionStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  }
}
