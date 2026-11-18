/**
 * Human-readable credit for a photo, derived from its provider or host.
 *
 * The gallery API sometimes knows the provider ("commons", "openverse") and
 * sometimes only has the final CDN URL, so both inputs are accepted. Returning
 * `undefined` is deliberate: a photo we cannot attribute stays uncredited
 * rather than getting an invented name.
 */

const PROVIDERS: Record<string, string> = {
  commons: "Wikimedia Commons",
  wikimedia: "Wikimedia Commons",
  wikipedia: "Wikipedia",
  wikidata: "Wikidata",
  openverse: "Openverse",
  pixabay: "Pixabay",
  pexels: "Pexels",
  unsplash: "Unsplash",
  google: "Google Images",
  osm: "OpenStreetMap",
};

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)commons\.wikimedia\.org$/i, "Wikimedia Commons"],
  [/(^|\.)upload\.wikimedia\.org$/i, "Wikimedia Commons"],
  [/(^|\.)openverse\.org$/i, "Openverse"],
  [/(^|\.)pixabay\.com$/i, "Pixabay"],
  [/(^|\.)pexels\.com$/i, "Pexels"],
  [/(^|\.)unsplash\.com$/i, "Unsplash"],
  [/(^|\.)staticflickr\.com$/i, "Flickr"],
  [/(^|\.)flickr\.com$/i, "Flickr"],
  [/(^|\.)googleusercontent\.com$/i, "Google Images"],
  [/(^|\.)gstatic\.com$/i, "Google Images"],
];

export function photoSourceName(
  source?: string | null,
  url?: string | null
): string | undefined {
  const key = source?.trim().toLowerCase();
  if (key && PROVIDERS[key]) return PROVIDERS[key];
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    for (const [pattern, label] of HOSTS) {
      if (pattern.test(host)) return label;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
