/**
 * Only offers a URL when it points at a real third-party site.
 *
 * Google-owned hosts (Maps, Travel, Search) are dropped: those results belong
 * in the in-app detail sheet and map, not a jump out of the site.
 */
export function externalWebsiteHref(url?: string | null): string | undefined {
  const raw = (url ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return undefined;
  try {
    const host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
    const isGoogle =
      host === "google.com" ||
      host.endsWith(".google.com") ||
      /^google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
    return isGoogle ? undefined : raw;
  } catch {
    return undefined;
  }
}
