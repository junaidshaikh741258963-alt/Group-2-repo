"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HomeBackground from "@/components/home/HomeBackground";
import LiveItineraryView from "@/components/trip/LiveItineraryView";
import TripItinerary from "@/components/trip/TripItinerary";
import { useLiveItinerary } from "@/components/trip/LiveItineraryContext";
import { useTripItems } from "@/components/trip/TripItemsContext";
import { hasStops } from "@/lib/liveItinerary";

type TripTab = "plan" | "board";

/**
 * The day-by-day live plan and the saved-items board are TWO different
 * things, so they get two panels:
 *
 *  - "Schedule" — the trip the AI built in chat: days, times, travel legs,
 *                 weather swaps, budget, map and exports (LiveItinerary).
 *  - "Board"    — the shortlist you saved yourself: every place, flight and
 *                 train you added, grouped by kind and reorderable
 *                 (TripItinerary).
 *
 * They were once stacked as two near-identical "your trip" sections — with
 * two empty states saying the same thing. A toggle replaced that, and the tab
 * was renamed "Plan" → "Schedule" so it no longer echoes the nav's
 * "Plan a trip" (the words looked like two doors to the same room). The rest
 * of the app (the nav badge, "Add to trip", the Book page) still calls the
 * shortlist the trip BOARD, so that tab keeps its name.
 *
 * The choice lives in the URL (`?tab=board`, mirroring the chat page's
 * `?view=`), so it survives refresh and can be shared.
 */
function ItineraryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { plan } = useLiveItinerary();
  const { items } = useTripItems();

  const param = searchParams.get("tab");
  // An explicit ?tab= always wins; otherwise land on whichever section has
  // content so a first-time visitor never opens on the "wrong" empty state.
  const tab: TripTab =
    param === "plan" || param === "board"
      ? param
      : hasStops(plan)
        ? "plan"
        : items.length > 0
          ? "board"
          : "plan";

  const selectTab = (next: TripTab) => {
    // Always write the param — a bare /itinerary would re-derive the default
    // and could bounce the click straight back to the other panel.
    router.replace(`/itinerary?tab=${next}`, { scroll: false });
  };

  const tabClass = (active: boolean) =>
    `h-8 px-4 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
      active
        ? "bg-surface-3 text-ink shadow-sm shadow-black/30"
        : "text-ink-muted hover:text-zinc-200"
    }`;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-8 md:px-6 lg:px-8">
      <HomeBackground />
      <header className="mt-8">
        <h1 className="text-2xl font-medium tracking-[-0.025em] text-ink md:text-3xl">
          Your trip
        </h1>
        <p className="mt-1 text-md text-ink-muted">
          The schedule from chat and the board of places, flights and trains you saved — both live
          on this trip.
        </p>
      </header>
      {/* Full-bleed sticky rail — sits under the 48px page header, panels
          scroll beneath it. */}
      <div className="sticky top-12 z-30 -mx-4 mt-5 border-b border-hairline bg-zinc-950/85 px-4 py-3 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            role="tablist"
            aria-label="Itinerary view"
            className="flex w-fit items-center gap-1 rounded-lg border border-hairline bg-surface-1 p-1"
          >
            <button
              type="button"
              id="itinerary-tab-plan"
              role="tab"
              aria-selected={tab === "plan"}
              aria-controls="itinerary-panel"
              onClick={() => selectTab("plan")}
              className={tabClass(tab === "plan")}
            >
              Schedule
            </button>
            <button
              type="button"
              id="itinerary-tab-board"
              role="tab"
              aria-selected={tab === "board"}
              aria-controls="itinerary-panel"
              onClick={() => selectTab("board")}
              className={tabClass(tab === "board")}
            >
              Board
            </button>
          </div>
          {/* One line that says what each tab holds — the two panels look
              alike, and "Schedule" / "Board" on their own do not say which
              is which. */}
          <p className="text-xs text-ink-faint">
            {tab === "plan" ? (
              <>
                <span className="font-medium text-ink-muted">Schedule</span> — the day-by-day plan
                built in chat, with times, travel and budget.
              </>
            ) : (
              <>
                <span className="font-medium text-ink-muted">Board</span> — everything you saved:
                places, flights and trains.
              </>
            )}
          </p>
        </div>
      </div>
      <div
        key={tab}
        id="itinerary-panel"
        role="tabpanel"
        aria-labelledby={`itinerary-tab-${tab}`}
        className="animate-view-in pt-6"
      >
        {tab === "plan" ? <LiveItineraryView /> : <TripItinerary />}
      </div>
    </div>
  );
}

export default function ItineraryPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-4 pb-8 pt-8 md:px-6 lg:px-8" aria-busy="true">
          <HomeBackground />
          <div className="h-12 animate-pulse rounded-xl border border-white/10 bg-surface-1" />
          <div className="mt-6 h-64 animate-pulse rounded-2xl border border-white/10 bg-surface-1" />
        </div>
      }
    >
      <ItineraryContent />
    </Suspense>
  );
}
