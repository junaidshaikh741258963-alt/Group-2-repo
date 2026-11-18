/**
 * Reachability check for gallery photos.
 *
 * Free sources and metered top-ups both occasionally hand back a dead link
 * (hotlink-protected hotel sites, deleted Flickr uploads, an expired Facebook
 * CDN URL). The browser then paints a "no photo" tile in an otherwise fine
 * gallery. A one-byte ranged GET tells us the difference cheaply, and callers
 * cache the answer with the gallery, so the cost is paid once per place.
 */

/** Total time the check may spend before the gallery must be returned. */
const VERIFY_BUDGET_MS = 2_500;
/** Per-URL ceiling once a request is in flight. */
const VERIFY_TIMEOUT_MS = 1_500;
/** Requests in flight at once — enough to finish a gallery quickly. */
const VERIFY_CONCURRENCY = 8;

/** Runs `worker` over the items with at most `limit` requests in flight. */
async function eachWithLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    })
  );
}

/**
 * Drops URLs the upstream says do not exist (404/410). A ranged GET is used
 * instead of HEAD because several image CDNs answer HEAD with 403/405 while
 * happily serving the image.
 *
 * Everything else is KEPT: a 403 is often bot protection that the proxy's
 * browser fallback clears, a 5xx may heal on retry, and a URL not reached
 * before the budget expires must not be silently deleted. The filter exists
 * to remove permanently-dead links, not to shrink a healthy gallery.
 */
export async function dropUnreachable(urls: readonly string[]): Promise<string[]> {
  if (urls.length === 0) return [];
  const dead = new Set<string>();
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  await eachWithLimit(urls, VERIFY_CONCURRENCY, async (url) => {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const timeout = Math.min(VERIFY_TIMEOUT_MS, left);
    try {
      const res = await fetch(url, {
        headers: { Range: "bytes=0-0", Accept: "image/*" },
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
      // Free the socket without reading the body; `cancel` is enough.
      await res.body?.cancel().catch(() => {});
      if (res.status === 404 || res.status === 410) dead.add(url);
    } catch {
      // Unknown/transient — keep it; the browser retry can still succeed.
    }
  });
  return urls.filter((url) => !dead.has(url));
}
