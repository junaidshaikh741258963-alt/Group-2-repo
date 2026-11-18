"use client";

import { memo } from "react";
import { useTripItems } from "@/components/trip/TripItemsContext";
import type { TripItemInput } from "@/lib/tripItems";

interface AddToTripButtonProps {
  item: TripItemInput;
  theme?: "dark" | "light";
  size?: "sm" | "icon";
  /** "solid" is the white photo-overlay disc; "chip" is the toolbar button. */
  appearance?: "chip" | "solid";
  title?: string;
  className?: string;
}

const ICON_PLUS = "M12 5v14M5 12h14";
const ICON_CHECK = "M5 13l4 4L19 7";

export default memo(function AddToTripButton({
  item,
  theme = "dark",
  size = "sm",
  appearance = "chip",
  title,
  className = "",
}: AddToTripButtonProps) {
  const { has, add, full } = useTripItems();
  const added = has(item.category, item.name);
  const blocked = full && !added;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (added || blocked) return;
    add(item);
  };

  const stateLabel = added ? "Added" : blocked ? "Board full" : "Add to trip";
  const stateTitle = added
    ? "Saved to your trip"
    : blocked
      ? "Your trip is full — remove items from the Board or start a new trip"
      : title || "Add to trip";

  if (size === "icon") {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={stateTitle}
        aria-label={added ? `${item.name} saved to trip` : `Add ${item.name} to trip`}
        aria-disabled={blocked}
        className={`relative grid shrink-0 place-items-center transition-colors focus-visible:outline-none focus-visible:ring-2 ${
          appearance === "solid"
            ? "h-7 w-7 rounded-full focus-visible:ring-white/70"
            : "h-5 w-5 rounded-md border focus-visible:ring-emerald-400/60 hit-44"
        } ${
          added
            ? appearance === "solid"
              ? "bg-white text-zinc-900"
              : "border-emerald-300 bg-emerald-500 text-white"
            : blocked
              ? "cursor-not-allowed border-amber-400/40 bg-amber-500/15 text-amber-200"
              : appearance === "solid"
                ? "bg-white/95 text-zinc-900 hover:bg-white active:bg-zinc-200"
                : theme === "dark"
                  ? "border-white/25 bg-black/50 text-white hover:border-white/50 hover:bg-black/70 active:bg-black/80"
                  : "border-slate-200 bg-white text-slate-500 hover:border-emerald-300 hover:text-emerald-600 active:bg-emerald-50"
        } ${added ? "animate-add-pop" : ""} ${className}`}
      >
        <svg
          className={appearance === "solid" ? "h-3.5 w-3.5" : "h-3 w-3"}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={added ? 3 : 2.4}
            d={added ? ICON_CHECK : blocked ? "M12 8v5m0 3h.01" : ICON_PLUS}
          />
        </svg>
      </button>
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={handleClick}
      title={stateTitle}
      aria-label={added ? `${item.name} saved to trip` : `Add ${item.name} to trip`}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-3 py-2 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${
        added
          ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 animate-add-pop"
          : blocked
            ? "cursor-not-allowed border-amber-400/40 bg-amber-500/10 text-amber-200"
            : isDark
              ? "border-zinc-700 bg-zinc-800/70 text-zinc-300 hover:border-emerald-400/60 hover:bg-emerald-500/10 hover:text-emerald-300"
              : "border-gray-200 bg-white text-gray-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
      } ${className}`}
    >
      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={added ? 3 : 2.2}
          d={added ? ICON_CHECK : blocked ? "M12 8v5m0 3h.01" : ICON_PLUS}
        />
      </svg>
      {stateLabel}
    </button>
  );
});
