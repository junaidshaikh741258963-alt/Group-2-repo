/**
 * Pixabay key pool — server-only (never imported by client components; the
 * browser only ever sees /api/img URLs, never a key).
 *
 * Pixabay allows ~100 requests/min PER KEY. Each UI surface that fires image
 * lookups has its own key so one busy surface can never starve another:
 *
 *   • "explore"  → the Explore grid (PIXABAY_API_KEY_EXPLORE)
 *   • "trip"     → trip/route pages + map cards (PIXABAY_API_KEY_TRIP)
 *   • "detail"   → the attraction/hotel details window (PIXABAY_API_KEY)
 *
 * Selection walks the surface's own key first, then the remaining pool
 * (deduped, per-key cooldowns skipped) — a 429'd key moves aside for a
 * minute instead of failing the lookup, and nothing ever retries the same
 * key twice within one request. With a single key configured the pool
 * degrades to exactly the old behaviour.
 */

export type PixabaySurface = "explore" | "trip" | "detail";

const COOLDOWN_MS = 60_000;
/** Per-key rate-limit cooldowns, keyed by the key itself. */
const keyCooldownUntil = new Map<string, number>();

export function isPixabaySurface(value: unknown): value is PixabaySurface {
  return value === "explore" || value === "trip" || value === "detail";
}

function envKey(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Every configured Pixabay key (deduped, cooldowns included). */
function pool(): string[] {
  return Array.from(
    new Set(
      [
        envKey("PIXABAY_API_KEY"),
        envKey("PIXABAY_API_KEY_TRIP"),
        envKey("PIXABAY_API_KEY_EXPLORE"),
      ].filter(Boolean)
    )
  );
}

/** The key assigned to a surface (falls back to the base key if unset). */
function surfaceKey(surface: PixabaySurface): string {
  if (surface === "explore") return envKey("PIXABAY_API_KEY_EXPLORE") || envKey("PIXABAY_API_KEY");
  if (surface === "trip") return envKey("PIXABAY_API_KEY_TRIP") || envKey("PIXABAY_API_KEY");
  return envKey("PIXABAY_API_KEY");
}

function keyAvailable(key: string): boolean {
  const until = keyCooldownUntil.get(key);
  if (until === undefined) return true;
  if (Date.now() < until) return false;
  keyCooldownUntil.delete(key);
  return true;
}

/**
 * Ordered candidate keys for one lookup: the surface's own key first, then
 * the rest of the pool. Rate-limited keys are skipped entirely, so a lookup
 * only ever sees keys that are expected to answer.
 */
export function pixabayKeyCandidates(surface?: PixabaySurface): string[] {
  const primary = surface ? surfaceKey(surface) : "";
  const rest = pool().filter((k) => k !== primary);
  return [primary, ...rest].filter((k) => k && keyAvailable(k));
}

/** A key answered 429/403 — park it briefly so the next lookup rotates past. */
export function cooldownPixabayKey(key: string): void {
  keyCooldownUntil.set(key, Date.now() + COOLDOWN_MS);
}

/** Test hook — forget every per-key cooldown. */
export function resetPixabayCooldowns(): void {
  keyCooldownUntil.clear();
}
