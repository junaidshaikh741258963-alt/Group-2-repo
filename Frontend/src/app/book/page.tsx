"use client";

import Link from "next/link";
import { useState } from "react";
import HomeBackground from "@/components/home/HomeBackground";
import BookFlights from "@/components/booking/BookFlights";
import BookTrains from "@/components/booking/BookTrains";
import { useTripItems } from "@/components/trip/TripItemsContext";

type Tab = "flights" | "trains";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: "flights",
    label: "Flights",
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 15.5 13.5 11V5.5a1.5 1.5 0 0 0-3 0V11L3 15.5v2l7.5-2.5v4L8 21v1.5l4-1 4 1V21l-2.5-2v-4L21 17.5v-2Z"
      />
    ),
  },
  {
    id: "trains",
    label: "Trains",
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 4h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM5 10.5h14M9 16l-2.5 4M15 16l2.5 4"
      />
    ),
  },
];

export default function BookPage() {
  const [tab, setTab] = useState<Tab>("flights");
  const { count } = useTripItems();

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 lg:px-8 py-8">
      <HomeBackground />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl md:text-3xl font-medium tracking-[-0.025em] text-ink">
            Flights and trains
          </h1>
          <p className="text-ink-muted text-md mt-2">
            Search live options and drop the ones you like on your trip board.
          </p>
        </div>
        <Link
          href="/itinerary"
          className="btn btn-quiet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 10h16M4 14h10M4 18h7"
            />
          </svg>
          Trip board
          {count > 0 && (
            <span className="inline-flex min-w-4.5 justify-center rounded-full bg-accent-strong px-2 text-3xs font-semibold leading-ui text-white tabular-nums">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Link>
      </div>

      <div className="flex items-center gap-1 mb-8 bg-surface-1 border border-hairline rounded-lg p-1 w-fit max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`flex shrink-0 h-9 items-center gap-2 px-4 md:px-6 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
              tab === t.id
                ? "bg-surface-3 text-ink shadow-sm shadow-black/30"
                : "text-ink-muted hover:text-zinc-200"
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {t.icon}
            </svg>
            {t.label}
          </button>
        ))}
      </div>

      <div key={tab} className="animate-view-in">
        {tab === "flights" ? <BookFlights /> : <BookTrains />}
      </div>
    </div>
  );
}
