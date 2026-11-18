/**
 * User duration overrides (Phase 4) — localStorage-backed, SSR-safe.
 *
 * A user's "2h" for the Louvre beats everything the model or the category
 * table guesses, for every future render of that place.
 */

const KEY = "tripcraft.duration-overrides.v1";
const EVENT = "tripcraft:durations-changed";

type Overrides = Record<string, number>;

function readAll(): Overrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 5 && n <= 720) out[k] = Math.round(n);
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Overrides): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // storage full / blocked — overrides are best-effort
  }
}

export function getDurationOverride(key: string): number | null {
  const all = readAll();
  return all[key] ?? null;
}

/** Set (or with `null`, clear) the user's estimate. Minutes are clamped. */
export function setDurationOverride(key: string, minutes: number | null): void {
  const all = readAll();
  if (minutes === null) {
    delete all[key];
  } else {
    all[key] = Math.max(5, Math.min(720, Math.round(minutes)));
  }
  writeAll(all);
}

export function allDurationOverrides(): Overrides {
  return readAll();
}

/** Subscribe to override changes (same tab + cross-tab). Returns unsubscribe. */
export function onDurationOverridesChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
