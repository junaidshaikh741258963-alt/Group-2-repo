"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import HotelDetailSheet from "@/components/explore/HotelDetailSheet";
import type { MapMarkerData } from "@/components/map/MapView";
import { categoryForType, peekPlaceImage, placePhotoKey } from "@/lib/placeImages";
import type { Recommendation } from "@/lib/recommendations";

const MapView = dynamic(() => import("@/components/map/MapView"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 bg-[#eaecef] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

interface MapPaneProps {
  markers: MapMarkerData[];
  results: Recommendation[];
  focusId: string | null;
  onFocus: (id: string) => void;
  onClose?: () => void;
  className?: string;
  /** Externally driven card-hover highlight (controlled when provided). */
  hoverId?: string | null;
  onHoverChange?: (id: string | null) => void;
  /** Lift details open to the parent (app-wide overlay). Falls back to internal sheet. */
  onOpenDetails?: (place: Recommendation) => void;
  /** Fired on marker tap (used to scroll chat to the matching card). */
  onMarkerTap?: (id: string) => void;
  /** Draw the ordered route line + numbered stops. */
  showRoute?: boolean;
  /** Show the expand-to-fullscreen button (desktop asides). */
  expandable?: boolean;
  /** Show the Leaflet +/- zoom control (hidden in chat, kept elsewhere). */
  zoomControl?: boolean;
  /** Back / collapse button pinned to the map's top-left. */
  onBack?: () => void;
  /** Closes the open place card (map tap, Escape, another pin). */
  onDismiss?: () => void;
  /** Search button + overlay next to the top-left buttons. */
  showSearch?: boolean;
  /** Weather chip at the map's bottom-left (Open-Meteo, cached per city). */
  showWeather?: boolean;
  /** City name behind the pin pill and the weather cache key. */
  city?: string;
  /** Space kept clear at the map's bottom (anything overlapping it). */
  bottomInset?: number;
  /**
   * External size signal (e.g. the app-wide detail window opening/closing).
   * Combined with the pane's own chrome changes to re-validate the map size.
   */
  syncToken?: number | string;
}

type PaneOverlay = "none" | "detail";

function MapPane({
  markers,
  results,
  focusId,
  onFocus,
  onClose,
  className = "",
  hoverId,
  onHoverChange,
  onOpenDetails,
  onMarkerTap,
  showRoute = false,
  expandable = false,
  zoomControl = true,
  onBack,
  onDismiss,
  showSearch = false,
  showWeather = false,
  city,
  bottomInset = 0,
  syncToken,
}: MapPaneProps) {
  const hasResults = results.length > 0;
  const [overlay, setOverlay] = useState<PaneOverlay>("none");
  const [localHover, setLocalHover] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const controlled = hoverId !== undefined;
  const hover = controlled ? hoverId : localHover;

  /**
   * Leaflet only re-measures when told to (`invalidateSize`). Bump a token
   * whenever the space around the map changes: once on mount (the pane is now
   * full-height — the bottom strip no longer reserves room), whenever the
   * pane's own detail sheet opens/closes, on fullscreen toggles, and whenever
   * the parent reports the app-wide detail window opening or closing.
   */
  const [paneTick, setPaneTick] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setPaneTick((v) => v + 1), 90);
    return () => window.clearTimeout(t);
  }, [overlay, expanded, syncToken]);
  const syncKey = `${paneTick}:${String(syncToken ?? "")}`;

  const handleHover = useCallback(
    (id: string | null) => {
      if (!controlled) setLocalHover(id);
      onHoverChange?.(id);
    },
    [controlled, onHoverChange]
  );

  const focusedPlace = useMemo(() => {
    if (!focusId) return null;
    const place = results.find((r) => r.id === focusId) ?? null;
    if (!place) return null;
    // The map card resolved its photo through the shared store — hand the
    // sheet that exact URL so the hero paints without a second lookup.
    const resolved = peekPlaceImage(
      placePhotoKey(categoryForType(place.type), place.name, place.city ?? "")
    );
    return resolved && resolved !== place.image ? { ...place, image: resolved } : place;
  }, [focusId, results]);

  const handleFocus = useCallback(
    (id: string) => {
      onFocus(id);
    },
    [onFocus]
  );

  const handleOpenDetails = useCallback(
    (id: string) => {
      const place =
        focusedPlace?.id === id
          ? focusedPlace
          : (() => {
              const p = results.find((r) => r.id === id);
              if (!p) return null;
              const resolved = peekPlaceImage(
                placePhotoKey(categoryForType(p.type), p.name, p.city ?? "")
              );
              return resolved && resolved !== p.image ? { ...p, image: resolved } : p;
            })();
      if (!place) return;
      onFocus(id);
      if (onOpenDetails) onOpenDetails(place);
      else setOverlay("detail");
    },
    [focusedPlace, results, onFocus, onOpenDetails]
  );

  const showPlaceSheet = overlay === "detail" && focusedPlace;

  // Fullscreen expand keeps the same Leaflet instance (position/zoom preserved);
  // the ResizeObserver in MapView revalidates tiles on the size change.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  return (
    <div
      className={
        expanded
          ? "fixed inset-0 z-[60] flex flex-col bg-zinc-950 animate-map-expand"
          : `relative flex flex-col bg-zinc-950 ${className}`
      }
    >
      {/* Map layer: z-0 + isolated, so nothing Leaflet renders (panes, popups,
          controls — raw z-indexes up to 1200) can ever escape this box. */}
      <div className="relative z-0 isolate overflow-hidden flex-1 min-h-0">
        {onClose && (
          <button
            onClick={onClose}
            className="absolute right-3 top-3 z-[1300] grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-zinc-950/90 text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-sm transition hover:border-white/30 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 lg:hidden"
            aria-label="Close map"
            title="Close map"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
        <MapView
          markers={markers}
          focusId={focusId}
          onFocus={handleFocus}
          hoverId={hover}
          onHoverChange={handleHover}
          onOpenDetails={handleOpenDetails}
          onMarkerTap={onMarkerTap}
          onDismiss={onDismiss}
          onBack={onBack}
          showSearch={showSearch}
          showWeather={showWeather}
          city={city}
          bottomInset={bottomInset}
          showRoute={showRoute}
          zoomControl={zoomControl}
          syncToken={syncKey}
        />
        {(expandable || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Back to chat and map" : "Expand map full screen"}
            aria-label={expanded ? "Back to chat and map" : "Expand map full screen"}
            className="absolute top-3 right-3 z-[1300] grid h-9 w-9 place-items-center rounded-xl border border-white/15 bg-zinc-950/90 text-zinc-200 shadow-lg shadow-black/40 transition hover:border-white/30 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
          >
            {expanded ? (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
                />
              </svg>
            )}
          </button>
        )}

        {!hasResults && overlay === "none" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6">
            <div className="max-w-[19rem] rounded-xl border border-white/10 bg-zinc-950/85 px-6 py-6 text-center shadow-2xl shadow-black/50">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg bg-accent-strong">
                <svg
                  className="w-5 h-5 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.9}
                    d="M17.657 16.657 13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.9}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </span>
              <p className="mt-4 text-base font-semibold text-ink">
                Your recommendations appear here
              </p>
              <p className="mt-2 text-xs text-ink-muted leading-relaxed">
                Ask about destinations, hotels or restaurants, and they show up as pins on the map.
              </p>
            </div>
          </div>
        )}

        {showPlaceSheet && focusedPlace && (
          <HotelDetailSheet
            key={focusedPlace.id}
            place={focusedPlace}
            onClose={() => setOverlay("none")}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Memoized: the chat page re-renders on every streaming token, and with the
 * marker/results identities stabilized upstream the pane now has nothing new
 * to render — so the Leaflet subtree is left untouched.
 */
export default memo(MapPane);
