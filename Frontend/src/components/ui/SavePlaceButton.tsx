"use client";

import { memo } from "react";
import {
  toggleSavedPlace,
  useSavedPlace,
  type SavedPlaceSnapshot,
} from "@/lib/savedPlaces";

interface SavePlaceButtonProps {
  placeKey: string;
  name: string;
  /** Snapshot persisted so the Saved page can show the place offline. */
  place?: SavedPlaceSnapshot;
  /** "ghost" is the photo-overlay heart; "chip" is the compact toolbar button. */
  appearance?: "chip" | "ghost";
  className?: string;
}

export default memo(function SavePlaceButton({
  placeKey,
  name,
  place,
  appearance = "chip",
  className = "",
}: SavePlaceButtonProps) {
  const saved = useSavedPlace(placeKey);
  const base =
    appearance === "ghost"
      ? "relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-black/40 text-white shadow-sm shadow-black/30 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-rose-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      : "relative grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors hit-44 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60";
  const state =
    appearance === "ghost"
      ? saved
        ? "bg-rose-500 text-white hover:bg-rose-500 hover:text-white animate-add-pop"
        : ""
      : saved
        ? "border-rose-300 bg-rose-500 text-white animate-add-pop"
        : "border-white/25 bg-black/50 text-white hover:border-white/50 hover:bg-black/70 hover:text-rose-300";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleSavedPlace(placeKey, place);
      }}
      title={saved ? "Saved" : "Save"}
      aria-label={saved ? `Remove ${name} from saved places` : `Save ${name}`}
      aria-pressed={saved}
      className={`${base} ${state} ${className}`}
    >
      <svg
        className={appearance === "ghost" ? "h-3.5 w-3.5" : "h-3 w-3"}
        viewBox="0 0 24 24"
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2.2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
        />
      </svg>
    </button>
  );
});
