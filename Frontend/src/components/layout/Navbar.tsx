"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Brand from "@/components/layout/Brand";

/**
 * The page header for every non-chat route. It is deliberately the same shape
 * and height as the chat header — 48px, one hairline, flat #0b0b0c — because
 * the rail already carries navigation. On phones it owns the hamburger and the
 * brand; from `lg` up the rail shows both, so the header leads with the page
 * title and the one white action.
 */
const TITLES: Record<string, string> = {
  "/plan": "Plan a trip",
  "/itinerary": "Your trip",
  "/book": "Book",
  "/trips": "Saved trips",
  "/saved": "Saved places",
};

export default function Navbar({ onOpenRail }: { onOpenRail: () => void }) {
  const pathname = usePathname();
  const title = TITLES[pathname ?? ""] ?? "TripCraft";
  /* The /plan page is the destination of the pill; repeating it there would
     just be a link to the page you are already on. */
  const showCreate = pathname !== "/plan";

  return (
    <header className="sticky top-0 z-40 h-12 shrink-0 border-b border-white/[0.07] bg-[#0b0b0c]">
      <div className="flex h-full items-center gap-2 px-3 md:px-4">
        <button
          type="button"
          onClick={onOpenRail}
          aria-label="Open navigation"
          title="Open navigation"
          className="nav-btn nav-btn-icon shrink-0 lg:hidden"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>

        <div className="lg:hidden">
          <Brand size="sm" />
        </div>

        <span className="hidden min-w-0 truncate text-sm font-semibold tracking-[-0.01em] text-ink md:block">
          {title}
        </span>

        {showCreate && (
          <Link
            href="/plan"
            className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3.5 text-xs font-semibold text-zinc-900 transition-colors hover:bg-zinc-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0b0c]"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              aria-hidden
            >
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
            Create a trip
          </Link>
        )}
      </div>
    </header>
  );
}
