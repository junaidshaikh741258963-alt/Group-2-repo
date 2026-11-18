export type TripCategory =
  "destination" | "hotel" | "restaurant" | "attraction" | "airport" | "flight" | "train" | "other";

export interface TripItem {
  key: string;
  name: string;
  category: TripCategory;
  description?: string;
  detail?: string;
  image?: string;
  rating?: number;
  price?: string;
  lat?: number;
  lng?: number;
  link?: string;
  addedAt: number;
}

export type TripItemInput = Omit<TripItem, "key" | "addedAt">;

const STORAGE_KEY = "tripcraft_trip_items";
/** Hard cap for the trip board — localStorage stays well under quota and the
 *  list stays renderable. Surfaced in the UI as a real, visible limit. */
export const TRIP_MAX_ITEMS = 200;

export function tripItemKey(category: TripCategory, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${category}:${slug || String(name).length}`;
}

export function tripCategoryMeta(category: TripCategory): {
  label: string;
  emoji: string;
  color: string;
} {
  switch (category) {
    case "destination":
      return { label: "Destination", emoji: "📍", color: "#3b82f6" };
    case "hotel":
      return { label: "Hotel", emoji: "🏨", color: "#a855f7" };
    case "restaurant":
      return { label: "Restaurant", emoji: "🍽️", color: "#f97316" };
    case "attraction":
      return { label: "Attraction", emoji: "🎯", color: "#10b981" };
    case "airport":
      return { label: "Airport", emoji: "✈️", color: "#38bdf8" };
    case "flight":
      return { label: "Flight", emoji: "✈️", color: "#0ea5e9" };
    case "train":
      return { label: "Train", emoji: "🚆", color: "#f59e0b" };
    default:
      return { label: "Saved", emoji: "📌", color: "#64748b" };
  }
}

export function createTripItem(input: TripItemInput): TripItem {
  return {
    ...input,
    key: tripItemKey(input.category, input.name),
    addedAt: Date.now(),
  };
}

export function loadTripItems(): TripItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is TripItem =>
          Boolean(x) &&
          typeof (x as TripItem).key === "string" &&
          typeof (x as TripItem).name === "string" &&
          typeof (x as TripItem).category === "string"
      )
      .slice(0, TRIP_MAX_ITEMS);
  } catch {
    return [];
  }
}

export function saveTripItems(items: TripItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, TRIP_MAX_ITEMS)));
  } catch {
    /* quota or unavailable — keep in-memory state */
  }
}
