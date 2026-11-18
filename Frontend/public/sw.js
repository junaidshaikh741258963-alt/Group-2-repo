/* TripCraft service worker.
 *
 * Strategy — cheap, boring, safe:
 *   • /api/*: never touched — chat streams and live data always go to the
 *     network, and /api/img answers with `Cache-Control: immutable`, so the
 *     browser's own HTTP cache holds it for a year. Intercepting it here
 *     would store every photo TWICE (CacheStorage + HTTP cache) and churn a
 *     capped cache with a background re-validate on each view, for no gain.
 *   • /_next/static + fonts: cache-first (content-hashed, immutable).
 *   • Navigations: network-first, falling back to the cached page (so
 *     pages you have visited — like Your trips — reopen offline), then
 *     the precached /offline shell.
 */
const VERSION = "tripcraft-v2";
const STATIC_CACHE = `${VERSION}-static`;
const PAGES_CACHE = `${VERSION}-pages`;
/** Capped cache for /_next/image + plain file images (NOT /api/img). */
const IMAGE_CACHE = `${VERSION}-img`;
const IMAGE_LIMIT = 120;

const PRECACHE = ["/offline", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const key of keys.slice(0, keys.length - max)) {
    await cache.delete(key);
  }
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && !response.redirected) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const offline = await caches.match("/offline");
    if (offline) return offline;
    return new Response("You are offline — reconnect and try again.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function staleWhileRevalidate(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
        if (max) trimCache(cacheName, max).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  const fresh = cached || (await network);
  return (
    fresh ||
    new Response("", { status: 504, statusText: "Offline and not cached" })
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Live APIs stay live: chat streaming, weather, flights, geocode.
  // Images too — /api/img is immutable for a year, so the HTTP cache is
  // already the single source of truth for photo bytes.
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/") || /\.(?:woff2?|ttf|otf)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else that is an image: /_next/image renditions and plain file
  // paths (photos a page links directly). /api/img never reaches here — the
  // /api/ check above already sent it to the browser's HTTP cache.
  if (request.destination === "image") {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, IMAGE_LIMIT));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});
