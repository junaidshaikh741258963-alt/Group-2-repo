/**
 * Photo identity without rendition query params — the dedupe key used by the
 * image history registry and every provider. Local proxy refs
 * (`/api/img?gphoto=…`) keep their query: it IS their identity.
 *
 * Lives in its own module so `server/imageHistory.ts` and the provider files
 * can share it without an import cycle.
 */
export function photoId(url: string): string {
  return url.startsWith("/") ? url : url.split("?")[0];
}
