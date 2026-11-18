/**
 * Shared between the client lookups (src/lib/placeImages.ts) and the server
 * route (/api/place-image) so both sides derive the exact same cache key —
 * and the same "city + category" fallback query (e.g. "Paris landmark") when
 * the specific place name finds no photo.
 */

export type ImageCategory = "city" | "landmark" | "restaurant" | "hotel" | "cafe" | "attraction";

const CATEGORIES: readonly ImageCategory[] = [
  "city",
  "landmark",
  "restaurant",
  "hotel",
  "cafe",
  "attraction",
];

export function isImageCategory(value: string): value is ImageCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** One stable identity per place: category|name|city, lowercased. */
export function placePhotoKey(category: ImageCategory, name: string, city = ""): string {
  return `${category}|${name.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

/** Broad second-chance query when the specific place name returns nothing. */
const CATEGORY_WORDS: Record<ImageCategory, string> = {
  city: "city skyline",
  landmark: "landmark",
  attraction: "landmark",
  restaurant: "restaurant",
  hotel: "hotel",
  cafe: "cafe",
};

export function cityPhotoQuery(category: ImageCategory, city: string): string {
  const c = city.trim();
  return c ? `${c} ${CATEGORY_WORDS[category]}` : "";
}
