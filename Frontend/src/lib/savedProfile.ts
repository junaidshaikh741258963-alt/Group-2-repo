/**
 * Lightweight, local-only personalisation for Explore's "For You" tab.
 *
 * We never invent preferences: the only signal is what the user explicitly
 * saved. A saved place votes for its category (and, weakly, for its city), so
 * clicking a heart nudges the next Explore visit without hiding anything or
 * needing an account.
 */

export interface SavedAffinity {
  types: Map<string, number>;
  cities: Set<string>;
  total: number;
}

export interface AffinityItem {
  kind: string;
  city?: string;
}

export function savedAffinity(
  places: ReadonlyArray<{ type: string; city?: string }>
): SavedAffinity {
  const types = new Map<string, number>();
  const cities = new Set<string>();
  for (const place of places) {
    const type = place.type.trim().toLowerCase();
    if (type) types.set(type, (types.get(type) ?? 0) + 1);
    const city = place.city?.trim().toLowerCase();
    if (city) cities.add(city);
  }
  return { types, cities, total: places.length };
}

/** Category matches count more than a shared city: taste travels, cities don't. */
export function affinityScore(item: AffinityItem, affinity: SavedAffinity): number {
  if (affinity.total === 0) return 0;
  const kind = item.kind.trim().toLowerCase();
  const city = item.city?.trim().toLowerCase();
  const kindVotes = affinity.types.get(kind) ?? 0;
  return kindVotes * 2 + (city && affinity.cities.has(city) ? 1 : 0);
}

/** Stable re-rank: higher affinity first, original order kept inside a score. */
export function rankByAffinity<T extends AffinityItem>(
  items: readonly T[],
  affinity: SavedAffinity
): T[] {
  if (affinity.total === 0 || items.length < 2) return items.slice();
  return items
    .map((item, index) => ({ item, index, score: affinityScore(item, affinity) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item);
}
