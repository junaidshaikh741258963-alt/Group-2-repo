"use client";

import { useEffect, useState } from "react";
import HotelDetailSheet from "@/components/explore/HotelDetailSheet";
import { useExitTransition } from "@/lib/useExitTransition";
import type { Recommendation } from "@/lib/recommendations";

interface PlaceDetailModalProps {
  place: Recommendation | null;
  onClose: () => void;
}

/**
 * Full-screen place/hotel details, opened on top of whatever screen you are on.
 * Every "view this place" affordance in the app routes here instead of leaving
 * for Google Maps.
 */
export default function PlaceDetailModal({ place, onClose }: PlaceDetailModalProps) {
  // Keep the last opened place around so it can fade out after closing —
  // adjusted during render when a new place arrives (no effect needed).
  const [lastPlace, setLastPlace] = useState<Recommendation | null>(place);
  if (place && place !== lastPlace) setLastPlace(place);
  const [mounted, closing] = useExitTransition(Boolean(place), 180);

  // Escape closes; background page stays locked while open.
  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [mounted, onClose]);

  if (!mounted || !lastPlace) return null;
  const active = place ?? lastPlace;

  return (
    /*
     * Layering scale for the map screens:
     *   0  map layer (Leaflet panes/controls are isolated inside it)
     *   40 map shells (mobile sheet, fullscreen expand, list overlays)
     *   50 THIS detail window — above every map surface, below pickers (1500)
     * The window is solid and scrolls internally, so no pin, popup or card can
     * show through it.
     */
    <div
      className={`fixed inset-0 z-50 flex justify-end ${
        closing ? "animate-exit pointer-events-none" : "animate-fade-in"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={`${active.name} details`}
    >
      {/* A place reads as a side panel on desktop (the chat stays in view) and
          as a full-screen sheet on a phone. */}
      <button
        type="button"
        aria-label="Close place details"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] md:bg-transparent md:backdrop-blur-none"
      />
      <div
        className="relative h-full w-full overflow-hidden bg-[#09090b] shadow-[-30px_0_80px_-30px_rgba(0,0,0,0.9)] md:w-[min(560px,calc(100vw-2.5rem))] md:border-l md:border-white/[0.09]"
        onClick={(e) => e.stopPropagation()}
      >
        <HotelDetailSheet key={active.id} place={active} onClose={onClose} mode="panel" />
      </div>
    </div>
  );
}
