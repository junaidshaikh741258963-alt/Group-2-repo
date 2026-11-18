package com.tripcraft.backend.rag;

import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Shared TTL cache + in-flight request deduplication (single-flight) — the
 * port of {@code src/server/cache.ts} living inside the RAG package.
 *
 * <ul>
 *   <li>{@link #cached} returns a fresh value when cached, otherwise runs the
 *       loader exactly once even if several callers ask for the same key at
 *       the same time.</li>
 *   <li>On loader failure the last stale value (if any) is served so one
 *       failing upstream never empties a working result.</li>
 * </ul>
 */
public final class TtlCache {

    private static final Logger log = LoggerFactory.getLogger(TtlCache.class);

    /** Process-wide cache shared by every RAG leg (TS {@code apiCache}). */
    private static final TtlCache INSTANCE = new TtlCache();

    /** Distinguishes "no entry" from "entry holding null" — TS {@code undefined}. */
    private static final Object MISSING = new Object();

    private static final class Entry {
        final Object value;
        final long expiresAt;
        final long staleUntil;

        Entry(Object value, long expiresAt, long staleUntil) {
            this.value = value;
            this.expiresAt = expiresAt;
            this.staleUntil = staleUntil;
        }
    }

    /** Options matching TS {@code WrapOptions}. */
    public record Options(long ttlMs, Long staleMs, boolean cacheEmpty) {
        public static Options of(long ttlMs) {
            return new Options(ttlMs, null, true);
        }

        public Options stale(long staleMs) {
            return new Options(ttlMs, staleMs, cacheEmpty);
        }

        public Options cacheEmpty(boolean cacheEmpty) {
            return new Options(ttlMs, staleMs, cacheEmpty);
        }
    }

    private static final int MAX_ENTRIES = 800;

    /** Insertion order = eviction order; re-inserted on read for LRU. */
    private final Map<String, Entry> store = new java.util.LinkedHashMap<>(16, 0.75f, false);
    private final Map<String, CompletableFuture<Object>> inflight = new ConcurrentHashMap<>();

    private TtlCache() {
    }

    /** {@link #MISSING} when absent/expired, else the (possibly null) value. */
    private Object getFresh(String key) {
        synchronized (store) {
            Entry e = store.get(key);
            if (e == null || System.currentTimeMillis() > e.expiresAt) {
                return MISSING;
            }
            // LRU: re-insert so the oldest keys are evicted first.
            store.remove(key);
            store.put(key, e);
            return e.value;
        }
    }

    /** Value that is past TTL but still usable when the upstream fails. */
    private Object getStale(String key) {
        synchronized (store) {
            Entry e = store.get(key);
            if (e == null || System.currentTimeMillis() > e.staleUntil) {
                return MISSING;
            }
            return e.value;
        }
    }

    private void set(String key, Object value, long ttlMs, long staleMs) {
        long now = System.currentTimeMillis();
        synchronized (store) {
            store.remove(key);
            store.put(key, new Entry(value, now + ttlMs, now + ttlMs + staleMs));
            while (store.size() > MAX_ENTRIES) {
                String oldest = store.keySet().iterator().next();
                if (oldest == null) {
                    break;
                }
                store.remove(oldest);
            }
        }
    }

    /** TS {@code isEmptyResult}: null, empty list, or first empty list field. */
    private static boolean isEmptyResult(Object value) {
        if (value == null) {
            return true;
        }
        if (value instanceof Iterable<?> iterable) {
            return !iterable.iterator().hasNext();
        }
        if (value instanceof Map<?, ?> map) {
            for (Object item : map.values()) {
                if (item instanceof Iterable<?> iterable) {
                    return !iterable.iterator().hasNext();
                }
            }
        }
        return false;
    }

    /**
     * Cached + de-duplicated loader. Falls back to stale data if the loader
     * throws after the value expired.
     */
    @SuppressWarnings("unchecked")
    public static <T> T cached(String key, Supplier<T> loader, Options opts) {
        Object fresh = INSTANCE.getFresh(key);
        if (fresh != MISSING) {
            return (T) fresh;
        }

        // single-flight: the first caller runs the loader, concurrent callers
        // share the same future (TS `singleFlight`).
        CompletableFuture<Object> created = new CompletableFuture<>();
        CompletableFuture<Object> existing = INSTANCE.inflight.putIfAbsent(key, created);
        if (existing != null) {
            try {
                return (T) existing.get();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException(e);
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof RuntimeException runtime) {
                    throw runtime;
                }
                throw new RuntimeException(cause);
            }
        }

        try {
            T value;
            try {
                value = loader.get();
                boolean empty = isEmptyResult(value);
                long ttl = (!opts.cacheEmpty() && empty)
                        ? Math.min(opts.ttlMs(), 60_000L) : opts.ttlMs();
                long staleMs = opts.staleMs() == null ? ttl * 6 : opts.staleMs();
                INSTANCE.set(key, value, ttl, staleMs);
                created.complete(value);
                return value;
            } catch (RuntimeException err) {
                Object stale = INSTANCE.getStale(key);
                if (stale != MISSING) {
                    log.warn("[cache] serving stale for {}: {}", key, messageOf(err));
                    @SuppressWarnings("unchecked")
                    T staleValue = (T) stale;
                    created.complete(staleValue);
                    return staleValue;
                }
                throw err;
            }
        } catch (RuntimeException err) {
            created.completeExceptionally(err);
            throw err;
        } finally {
            INSTANCE.inflight.remove(key, created);
        }
    }

    private static String messageOf(Throwable err) {
        String message = err.getMessage();
        return message != null ? message : String.valueOf(err);
    }

    /** Stable cache key from an object (sorted keys → order-independent). */
    public static String cacheKey(String namespace, Map<String, ?> params) {
        Map<String, Object> sorted = new TreeMap<>(params);
        StringBuilder parts = new StringBuilder();
        boolean first = true;
        for (Map.Entry<String, Object> entry : sorted.entrySet()) {
            if (!first) {
                parts.append('|');
            }
            first = false;
            Object value = entry.getValue();
            parts.append(entry.getKey()).append('=').append(value == null ? "" : String.valueOf(value));
        }
        return namespace + "::" + parts;
    }
}
