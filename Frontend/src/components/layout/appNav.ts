/**
 * One navigation list for the whole app. The chat rail and the page rail both
 * read from here so a destination can never drift between the two shells.
 *
 * Inspiration and Agents used to sit here as aliases for Explore and the
 * "Create a trip" action; they are gone, and Book (formerly Create) is the one
 * booking destination.
 */
export interface AppNavItem {
  readonly href: string;
  readonly label: string;
  /** 24×24 outline path, drawn with the shared `strokeWidth` in each rail. */
  readonly icon: string;
}

export const APP_NAV: readonly AppNavItem[] = [
  {
    href: "/",
    label: "Home",
    icon: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10.5Z",
  },
  {
    href: "/chat",
    label: "Chats",
    icon: "M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72A7.9 7.9 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z",
  },
  {
    href: "/trips",
    label: "Trips",
    icon: "M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5Z",
  },
  {
    href: "/explore",
    label: "Explore",
    icon: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  },
  {
    href: "/saved",
    label: "Saved",
    icon: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8Z",
  },
  {
    href: "/itinerary",
    label: "Updates",
    icon: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  },
  {
    href: "/book",
    label: "Book",
    icon: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7ZM14 5v14",
  },
] as const;

export function isAppNavActive(
  href: string,
  pathname: string | null | undefined
): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
