import { useCallback, useSyncExternalStore } from "react";

const KEYS_KEY = "tripcraft_saved_places";
const DETAILS_KEY = "tripcraft_saved_place_details";
const MAX_SAVED = 500;

/** Everything we know about a place at the moment it is saved. */
export interface SavedPlaceSnapshot {
  type: string;
  name: string;
  lat?: number;
  lng?: number;
  city?: string;
  rating?: number;
  reviews?: number;
  price?: string;
  image?: string;
}

export interface SavedPlace extends SavedPlaceSnapshot {
  key: string;
  savedAt: number;
}

type StoredDetail = SavedPlaceSnapshot & { savedAt: number };

let keysCache: string[] | null = null;
let detailsCache: Record<string, StoredDetail> | null = null;
let listCache: SavedPlace[] | null = null;
const listeners = new Set<() => void>();
const EMPTY: SavedPlace[] = [];

function readKeys(): string[] {
  if (keysCache) return keysCache;
  if (typeof window === "undefined") {
    keysCache = [];
    return keysCache;
  }
  try {
    const raw = window.localStorage.getItem(KEYS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    keysCache = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_SAVED)
      : [];
  } catch {
    keysCache = [];
  }
  return keysCache;
}

function readDetails(): Record<string, StoredDetail> {
  if (detailsCache) return detailsCache;
  if (typeof window === "undefined") {
    detailsCache = {};
    return detailsCache;
  }
  const out: Record<string, StoredDetail> = {};
  try {
    const raw = window.localStorage.getItem(DETAILS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object") continue;
        const d = value as Partial<StoredDetail>;
        if (typeof d.type !== "string" || typeof d.name !== "string") continue;
        out[key] = {
          type: d.type,
          name: d.name,
          lat: typeof d.lat === "number" && Number.isFinite(d.lat) ? d.lat : undefined,
          lng: typeof d.lng === "number" && Number.isFinite(d.lng) ? d.lng : undefined,
          city: typeof d.city === "string" ? d.city : undefined,
          rating: typeof d.rating === "number" ? d.rating : undefined,
          reviews: typeof d.reviews === "number" ? d.reviews : undefined,
          price: typeof d.price === "string" ? d.price : undefined,
          image: typeof d.image === "string" ? d.image : undefined,
          savedAt: typeof d.savedAt === "number" ? d.savedAt : 0,
        };
      }
    }
  } catch {
    // ignore corrupt storage
  }
  detailsCache = out;
  return detailsCache;
}

function commit(nextKeys: string[], nextDetails: Record<string, StoredDetail>) {
  const keys = nextKeys.slice(0, MAX_SAVED);
  const details: Record<string, StoredDetail> = {};
  for (const key of keys) {
    if (nextDetails[key]) details[key] = nextDetails[key];
  }
  keysCache = keys;
  detailsCache = details;
  listCache = null;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
      window.localStorage.setItem(DETAILS_KEY, JSON.stringify(details));
    }
  } catch {
    /* quota or unavailable — keep in-memory state */
  }
  listeners.forEach((listener) => listener());
}

export function savedPlaceKey(type: string, name: string): string {
  return `${type}:${name.trim().toLowerCase()}`;
}

export function toggleSavedPlace(key: string, place?: SavedPlaceSnapshot): void {
  const current = readKeys();
  const details = { ...readDetails() };
  if (current.includes(key)) {
    delete details[key];
    commit(
      current.filter((k) => k !== key),
      details
    );
    return;
  }
  const sep = key.indexOf(":");
  const type = place?.type ?? (sep > 0 ? key.slice(0, sep) : "place");
  const name = place?.name ?? (sep > 0 ? key.slice(sep + 1) : key);
  const nextDetails: Record<string, StoredDetail> = {
    ...details,
    [key]: { ...place, type, name, savedAt: Date.now() },
  };
  const nextKeys = [key, ...current.filter((k) => k !== key)].slice(0, MAX_SAVED);
  commit(nextKeys, nextDetails);
}

export function removeSavedPlace(key: string): void {
  if (!readKeys().includes(key)) return;
  toggleSavedPlace(key);
}

export function clearSavedPlaces(): void {
  if (readKeys().length === 0) return;
  commit([], {});
}

export function useSavedPlace(key: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const getSnapshot = useCallback(() => readKeys().includes(key), [key]);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Every saved place, newest first. Legacy key-only saves keep their name. */
export function getSavedPlacesSnapshot(): SavedPlace[] {
  if (listCache) return listCache;
  const details = readDetails();
  listCache = readKeys().map((key) => {
    const detail = details[key];
    if (detail) return { key, ...detail };
    const sep = key.indexOf(":");
    return {
      key,
      type: sep > 0 ? key.slice(0, sep) : "place",
      name: sep > 0 ? key.slice(sep + 1) : key,
      savedAt: 0,
    };
  });
  return listCache;
}

/** Every saved place, newest first. Legacy key-only saves keep their name. */
export function useSavedPlaces(): SavedPlace[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const getSnapshot = useCallback(() => getSavedPlacesSnapshot(), []);
  const getServerSnapshot = useCallback(() => EMPTY, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
