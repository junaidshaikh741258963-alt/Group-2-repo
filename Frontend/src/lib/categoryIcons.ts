/**
 * Stroke icon paths (24x24 grid) used in place of emoji glyphs so every
 * category marker shares one visual language.
 */
export const CATEGORY_ICON_PATHS: Record<string, string[]> = {
  destination: [
    "M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    "M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z",
  ],
  hotel: [
    "M3 18v-6.5A2.5 2.5 0 0 1 5.5 9h13a2.5 2.5 0 0 1 2.5 2.5V18",
    "M3 14.75h18",
    "M6.5 9V6.75A1.75 1.75 0 0 1 8.25 5h3.5A1.75 1.75 0 0 1 13.5 6.75V9",
    "M3 18v1.75M21 18v1.75",
  ],
  restaurant: [
    "M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2",
    "M7 2v20",
    "M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7",
  ],
  attraction: [
    "M3 21h18",
    "M5.25 21V9.75M9.75 21V9.75M14.25 21V9.75M18.75 21V9.75",
    "M3 9.75h18",
    "M12 3l9 6.75H3L12 3Z",
  ],
  flight: [
    "M21 15.5 13.5 11V5.5a1.5 1.5 0 0 0-3 0V11L3 15.5v2l7.5-2.5v4L8 21v1.5l4-1 4 1V21l-2.5-2v-4L21 17.5v-2Z",
  ],
  /* Same plane glyph, keyed by the category the map pin uses. */
  airport: [
    "M21 15.5 13.5 11V5.5a1.5 1.5 0 0 0-3 0V11L3 15.5v2l7.5-2.5v4L8 21v1.5l4-1 4 1V21l-2.5-2v-4L21 17.5v-2Z",
  ],
  train: [
    "M8 4h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z",
    "M5 10.5h14",
    "M9 16l-2.5 4M15 16l2.5 4",
    "M9 13.5h.01M15 13.5h.01",
  ],
  saved: ["M6.5 4h11a1 1 0 0 1 1 1v15.5L12 16l-6.5 4.5V5a1 1 0 0 1 1-1Z"],
  shopping: ["M6.5 8h11l-1 12.5h-9L6.5 8Z", "M9 8V6.5a3 3 0 0 1 6 0V8"],
  other: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 8v8M8 12h8"],
};

/** Words the UI may hand in that stand for one of the categories above. */
const ALIASES: Record<string, string> = {
  food: "restaurant",
  cafe: "restaurant",
  coffee: "restaurant",
  bar: "restaurant",
  dining: "restaurant",
  shop: "shopping",
  mall: "shopping",
  store: "shopping",
  market: "shopping",
  sight: "attraction",
  landmark: "attraction",
  museum: "attraction",
  things_to_do: "attraction",
  poi: "attraction",
  lodging: "hotel",
  accommodation: "hotel",
  plane: "airport",
};

export function categoryIconPaths(kind: string): string[] {
  const key = String(kind ?? "")
    .trim()
    .toLowerCase();
  const mapped = ALIASES[key] ?? key;
  return CATEGORY_ICON_PATHS[mapped] ?? CATEGORY_ICON_PATHS.other;
}

/** Same paths as raw markup, for markers rendered through Leaflet's divIcon. */
export function categoryIconSvg(kind: string, className = ""): string {
  const paths = categoryIconPaths(kind)
    .map((d) => `<path d="${d}"/>`)
    .join("");
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
