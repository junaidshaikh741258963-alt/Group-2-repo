"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTripItems } from "@/components/trip/TripItemsContext";
import {
  tripCategoryMeta,
  TRIP_MAX_ITEMS,
  type TripItem,
  type TripCategory,
} from "@/lib/tripItems";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";

interface SectionDef {
  category: TripCategory;
  title: string;
  hint: string;
  href: string;
  cta: string;
}

const SECTIONS: SectionDef[] = [
  {
    category: "destination",
    title: "Destinations",
    hint: "Cities and regions on this trip",
    href: "/chat",
    cta: "Plan in chat",
  },
  {
    category: "hotel",
    title: "Stays",
    hint: "Hotels, hostels and places to sleep",
    href: "/chat",
    cta: "Find stays",
  },
  {
    category: "attraction",
    title: "Things to do",
    hint: "Sights, activities and day trips",
    href: "/chat?view=explore",
    cta: "Explore places",
  },
  {
    category: "restaurant",
    title: "Food & drink",
    hint: "Restaurants, cafes and food spots",
    href: "/chat",
    cta: "Find restaurants",
  },
  {
    category: "flight",
    title: "Flights",
    hint: "Fares and flight numbers",
    href: "/book",
    cta: "Search flights",
  },
  {
    category: "train",
    title: "Trains",
    hint: "Rail legs and departure times",
    href: "/book",
    cta: "Search trains",
  },
  {
    category: "other",
    title: "Everything else",
    hint: "Saved items without a category",
    href: "/chat",
    cta: "Add in chat",
  },
];

function ItemThumb({ item }: { item: TripItem }) {
  const meta = tripCategoryMeta(item.category);
  const [failed, setFailed] = useState(false);
  const showImg = Boolean(item.image) && !failed;

  return (
    <div
      className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg"
      style={{ color: meta.color, backgroundColor: `${meta.color}26` }}
    >
      {showImg ? (
        <SmartImage
          src={item.image!}
          alt=""
          onError={() => setFailed(true)}
          sizes="44px"
          widths={[160]}
          className="h-full w-full object-cover"
        />
      ) : (
        <CategoryIcon kind={item.category} className="h-5 w-5" />
      )}
    </div>
  );
}

export default function TripItinerary() {
  const { items, remove, reorder, clear, full } = useTripItems();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const sections = useMemo(() => {
    return SECTIONS.map((def) => ({
      def,
      entries: items
        .map((item, index) => ({ item, index }))
        .filter((entry) => entry.item.category === def.category),
    }));
  }, [items]);

  const filledCount = sections.filter((s) => s.entries.length > 0).length;

  const flash = (key: string) => {
    setFlashKey(key);
    window.setTimeout(() => setFlashKey((k) => (k === key ? null : k)), 500);
  };

  /** Two-step clear: first click arms the button, the second one wipes the
   *  board. Leaving the button disarms it, so nothing is ever one stray click
   *  away from losing the plan. */
  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    clear();
  };

  const handleRemove = (key: string) => {
    if (removingKey) return;
    setRemovingKey(key);
    window.setTimeout(() => {
      remove(key);
      setRemovingKey((k) => (k === key ? null : k));
    }, 180);
  };

  /** Move an item within its own section, keeping other sections untouched. */
  const handleMove = (
    entry: { item: TripItem; index: number },
    siblings: { item: TripItem; index: number }[],
    dir: -1 | 1
  ) => {
    const pos = siblings.findIndex((s) => s.item.key === entry.item.key);
    const target = siblings[pos + dir];
    if (!target) return;
    reorder(entry.index, target.index);
    flash(entry.item.key);
  };

  const resetDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  const handleDrop = (toIndex: number) => {
    const from = dragIndex;
    resetDrag();
    if (from === null || from === toIndex) return;
    const source = items[from];
    const target = items[toIndex];
    if (!source || !target || source.category !== target.category) return;
    reorder(from, toIndex);
    flash(source.key);
  };

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/50 px-6 py-16 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-surface-2 text-ink-faint">
          <CategoryIcon kind="saved" className="h-6 w-6" />
        </span>
        {/* "Your board" — the app calls this the trip board everywhere else
            (the nav badge, "Add to trip", the Book page). Calling it
            "itinerary" here put two different things under one name on one
            page: the schedule (Plan) and the shortlist (Board). */}
        <h3 className="mt-4 text-lg font-semibold text-ink">Your board is empty</h3>
        <p className="mx-auto mt-2 max-w-md text-base leading-relaxed text-ink-muted">
          Save hotels, restaurants and sights from the chat, search flights and trains in Book, and
          everything lands here — sorted into sections. Build a trip in chat and the{" "}
          <span className="text-ink-muted">Plan</span> tab schedules it day by day.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/chat"
            className="rounded-lg bg-accent-strong px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent"
          >
            Open chat
          </Link>
          <Link
            href="/book"
            className="rounded-lg border border-white/[0.12] px-6 py-3 text-base font-medium text-zinc-200 transition-colors hover:bg-surface-2"
          >
            Book a flight or train
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {/* The shortlist — the schedule lives in the Plan tab. */}
          <h2 className="text-xl font-semibold tracking-tight text-ink">Your board</h2>
          <p className="mt-1 text-base text-ink-muted">
            {items.length} {items.length === 1 ? "item" : "items"} · {filledCount} of{" "}
            {SECTIONS.length} sections filled. Drag within a section to reorder.
            {items.length >= TRIP_MAX_ITEMS * 0.8 && (
              <span className={full ? "font-medium text-amber-300" : "text-ink-faint"}>
                {" "}
                · {items.length}/{TRIP_MAX_ITEMS} slots used
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleClear}
          onMouseLeave={() => setConfirmClear(false)}
          onBlur={() => setConfirmClear(false)}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
            confirmClear
              ? "border-red-500/60 bg-red-500/15 text-red-300"
              : "border-zinc-700 text-ink-muted hover:border-red-500/40 hover:bg-red-500/10 hover:text-danger"
          }`}
        >
          {confirmClear ? "Click again to clear" : "Clear all"}
        </button>
      </div>

      {full && (
        <div className="mb-6 animate-card-in overflow-hidden rounded-xl border border-amber-400/35 bg-amber-500/[0.08]">
          <div className="flex items-start gap-3 px-4 py-4">
            <span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-warn/15 text-amber-300">
              <svg
                className="h-4.5 w-4.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-md font-semibold text-amber-100">
                Your board is full — {TRIP_MAX_ITEMS} of {TRIP_MAX_ITEMS} slots used
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-amber-100/70">
                New saves are paused so the board stays fast. Remove items you no longer need, or
                start a fresh board for the next trip.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleClear}
                  onMouseLeave={() => setConfirmClear(false)}
                  onBlur={() => setConfirmClear(false)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    confirmClear
                      ? "bg-red-500 text-white hover:bg-danger"
                      : "bg-warn text-zinc-950 hover:bg-amber-300"
                  }`}
                >
                  {confirmClear ? `Yes, clear all ${items.length} items` : "Start a new board"}
                </button>
                <Link
                  href="/trips"
                  className="rounded-lg border border-amber-300/30 px-4 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-warn/10"
                >
                  Open my trips
                </Link>
                <Link
                  href="/chat"
                  className="rounded-lg border border-amber-300/30 px-4 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-warn/10"
                >
                  Review plan in chat
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {!full && filledCount === SECTIONS.length && (
        <div className="mb-6 animate-card-in overflow-hidden rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07]">
          <div className="flex items-start gap-3 px-4 py-4">
            <span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ok/15 text-emerald-300">
              <svg
                className="h-4.5 w-4.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-md font-semibold text-emerald-100">
                Plan complete — all {SECTIONS.length} sections filled
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-emerald-100/70">
                {items.length} {items.length === 1 ? "item" : "items"} across destinations, stays,
                food, sights and transport. Next: book the legs you still need.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href="/book"
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-ok"
                >
                  Book flights &amp; trains
                </Link>
                <Link
                  href="/chat"
                  className="rounded-lg border border-emerald-300/30 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-ok/10"
                >
                  Keep refining in chat
                </Link>
                <Link
                  href="/trips"
                  className="rounded-lg border border-emerald-300/30 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-ok/10"
                >
                  Open my trips
                </Link>
                <button
                  type="button"
                  onClick={handleClear}
                  onMouseLeave={() => setConfirmClear(false)}
                  onBlur={() => setConfirmClear(false)}
                  className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                    confirmClear
                      ? "border-red-500/60 bg-red-500/15 text-red-300"
                      : "border-emerald-300/25 text-emerald-100/80 hover:border-red-500/40 hover:text-red-300"
                  }`}
                >
                  {confirmClear ? "Confirm: start over" : "Start a new plan"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {sections.map(({ def, entries }) => {
          const meta = tripCategoryMeta(def.category);

          if (entries.length === 0) {
            return (
              <div
                key={def.category}
                className="flex items-center gap-3 rounded-xl border border-dashed border-hairline px-4 py-3"
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg opacity-60"
                  style={{ color: meta.color, backgroundColor: `${meta.color}1f` }}
                >
                  <CategoryIcon kind={def.category} className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-faint">{def.title}</div>
                  <div className="truncate text-xs text-zinc-600">{def.hint}</div>
                </div>
                <Link
                  href={def.href}
                  className="shrink-0 rounded-lg border border-white/[0.1] px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-blue-200"
                >
                  {def.cta}
                </Link>
              </div>
            );
          }

          return (
            <section
              key={def.category}
              className="overflow-hidden rounded-xl border border-hairline bg-zinc-900/70"
            >
              <header className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                  style={{ color: meta.color, backgroundColor: `${meta.color}26` }}
                >
                  <CategoryIcon kind={def.category} className="h-4 w-4" />
                </span>
                <h3 className="text-base font-semibold text-ink">{def.title}</h3>
                <span className="rounded-full bg-surface-3 px-2 py-1 text-2xs font-semibold text-zinc-300 tabular-nums">
                  {entries.length}
                </span>
                <p className="ml-auto hidden truncate text-xs text-ink-faint md:block">
                  {def.hint}
                </p>
              </header>

              <ul className="divide-y divide-white/[0.05]">
                {entries.map((entry, pos) => {
                  const { item, index } = entry;
                  const isRemoving = removingKey === item.key;
                  const isDragging = dragIndex === index;
                  const isOver = overIndex === index && dragIndex !== null && dragIndex !== index;
                  const isFlashing = flashKey === item.key;

                  return (
                    <li
                      key={item.key}
                      draggable
                      onDragStart={(e) => {
                        setDragIndex(index);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(index));
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        // Same-row repeats are the common case (dragOver fires
                        // for every pixel of movement) — bail before setState
                        // so a drag doesn't schedule work on every mousemove.
                        if (dragIndex === index || overIndex === index) return;
                        setOverIndex(index);
                      }}
                      onDragEnd={resetDrag}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleDrop(index);
                      }}
                      className={[
                        "group flex items-center gap-3 px-3 py-3 animate-card-in transition-all duration-200 cv-row",
                        isDragging ? "bg-accent/10 opacity-50" : "",
                        isOver
                          ? "bg-accent/[0.07] shadow-[inset_0_-2px_0_0] shadow-blue-500/70"
                          : "",
                        isFlashing ? "bg-emerald-500/[0.08]" : "",
                        isRemoving ? "opacity-0 -translate-x-3 scale-[0.98]" : "opacity-100",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <span
                        className="hidden md:grid cursor-grab active:cursor-grabbing place-items-center text-zinc-600 transition-colors group-hover:text-ink-muted"
                        aria-hidden
                        title="Drag to reorder"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="9" cy="6" r="1.6" />
                          <circle cx="9" cy="12" r="1.6" />
                          <circle cx="9" cy="18" r="1.6" />
                          <circle cx="15" cy="6" r="1.6" />
                          <circle cx="15" cy="12" r="1.6" />
                          <circle cx="15" cy="18" r="1.6" />
                        </svg>
                      </span>

                      <ItemThumb item={item} />

                      <div className="min-w-0 flex-1">
                        <div className="truncate text-md font-medium text-ink">{item.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
                          <span className="truncate">
                            {item.detail || item.description || "\u00A0"}
                          </span>
                          {item.rating != null && (
                            <span className="shrink-0 font-medium text-warn">★ {item.rating}</span>
                          )}
                          {item.price && (
                            <span className="shrink-0 font-medium text-ok">{item.price}</span>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleMove(entry, entries, -1)}
                          disabled={pos === 0}
                          aria-label={`Move ${item.name} up`}
                          className="relative grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-3 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 after:absolute after:-inset-2 after:content-['']"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2.2}
                              d="M5 15l7-7 7 7"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMove(entry, entries, 1)}
                          disabled={pos === entries.length - 1}
                          aria-label={`Move ${item.name} down`}
                          className="relative grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-3 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 after:absolute after:-inset-2 after:content-['']"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2.2}
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemove(item.key)}
                          aria-label={`Remove ${item.name}`}
                          className="relative grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-red-500/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 after:absolute after:-inset-2 after:content-['']"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <p className="text-sm text-ink-faint">
          Saved items live in your browser for this trip board.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/chat"
            className="rounded-lg border border-white/[0.1] px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-2"
          >
            Add from chat
          </Link>
          <Link
            href="/book"
            className="rounded-lg border border-white/[0.1] px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-2"
          >
            Search flights &amp; trains
          </Link>
        </div>
      </div>
    </div>
  );
}
