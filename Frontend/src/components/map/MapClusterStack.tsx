"use client";

import { memo, useRef } from "react";
import { recMeta } from "@/lib/recommendations";
import { usePlaceImage } from "@/lib/placeImages";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";
import type { MapMarkerData } from "@/components/map/MapView";

interface StackRowProps {
  marker: MapMarkerData;
  onSelect: (id: string) => void;
}

const StackRow = memo(function StackRow({ marker, onSelect }: StackRowProps) {
  const meta = recMeta(marker.kind);
  const hostRef = useRef<HTMLButtonElement>(null);
  const { url: img, onImgError } = usePlaceImage(
    { name: marker.label, type: marker.kind, image: marker.image, surface: "trip" },
    hostRef
  );

  return (
    <button
      type="button"
      ref={hostRef}
      onClick={() => onSelect(marker.id)}
      title={marker.label}
      className="map-stack-row flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60"
    >
      <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md bg-zinc-800">
        {img ? (
          /* SmartImage (not a raw <img>): proxied through /api/img with the
             shared decode-once fade, one bounded retry, then the fallback. */
          <SmartImage
            src={img}
            alt=""
            width={32}
            height={32}
            loading="lazy"
            sizes="32px"
            widths={[160]}
            className="h-full w-full object-cover"
            onError={onImgError}
            fallback={
              <span className="grid h-full w-full place-items-center text-ink-faint" aria-hidden="true">
                <CategoryIcon kind={marker.kind} className="w-4 h-4" />
              </span>
            }
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-ink-faint" aria-hidden="true">
            <CategoryIcon kind={marker.kind} className="w-4 h-4" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold leading-tight text-ink">
          {marker.label}
        </span>
        <span className="mt-1 flex items-center gap-1 text-3xs text-ink-muted">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />
          <span className="truncate">{marker.price ?? meta.label}</span>
          {marker.durationText && (
            <span className="shrink-0 tabular-nums text-ink-faint">· {marker.durationText}</span>
          )}
        </span>
      </span>
      {marker.rating != null && (
        <span className="shrink-0 text-3xs font-bold text-warn">★ {marker.rating}</span>
      )}
    </button>
  );
});

interface MapClusterStackProps {
  items: MapMarkerData[];
  total: number;
  onSelect: (id: string) => void;
  onEnter: () => void;
  onLeave: () => void;
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * What's inside a cluster: a compact list floating above the bubble, shown
 * while the cluster is hovered (markercluster's own coverage box is off).
 * MapView owns the positioning — this only renders the panel.
 */
const MapClusterStack = memo(function MapClusterStack({
  items,
  total,
  onSelect,
  onEnter,
  onLeave,
  ref,
}: MapClusterStackProps) {
  return (
    <div
      ref={ref}
      className="map-stack"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      role="group"
      aria-label={`${total} places in this cluster`}
    >
      <div className="map-stack-head">
        <span className="map-stack-dot" aria-hidden="true" />
        <span className="truncate tabular-nums">
          {total} {total === 1 ? "place" : "places"} here
        </span>
      </div>
      <div className="map-stack-rows">
        {items.map((m) => (
          <StackRow key={m.id} marker={m} onSelect={onSelect} />
        ))}
      </div>
      {total > items.length && (
        <div className="map-stack-more tabular-nums">+{total - items.length} more · zoom in</div>
      )}
    </div>
  );
});

export default MapClusterStack;
