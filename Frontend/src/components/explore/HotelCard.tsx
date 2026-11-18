"use client";

import { memo, useCallback, useRef, useState } from "react";
import type { Hotel } from "@/lib/hotels";
import { usePlaceImage } from "@/lib/placeImages";
import SmartImage from "@/components/ui/SmartImage";
import AddToTripButton from "@/components/ui/AddToTripButton";
import CategoryIcon from "@/components/ui/CategoryIcon";

interface HotelCardProps {
  hotel: Hotel;
  onSelect?: (hotel: Hotel) => void;
}

export default memo(function HotelCard({ hotel, onSelect }: HotelCardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Reuses the shared per-place store: a hotel photo already resolved by
  // Explore, the map or a detail sheet paints here with no second lookup;
  // otherwise a bounded lookup resolves "<city> hotel" via Pixabay.
  const { url, onImgError } = usePlaceImage(
    {
      name: hotel.name,
      type: "hotel",
      lat: hotel.lat,
      lng: hotel.lng,
      city: hotel.city,
      surface: "trip",
    },
    hostRef
  );
  // Track the last src that failed so a re-resolved replacement can retry,
  // instead of pinning the failure placeholder forever.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImg = Boolean(url) && url !== failedSrc;

  const handleImgError = useCallback(() => {
    setFailedSrc(url ?? null);
    onImgError();
  }, [url, onImgError]);

  const handleSelect = useCallback(() => {
    onSelect?.(hotel);
  }, [onSelect, hotel]);

  return (
    <div
      ref={hostRef}
      role="button"
      tabIndex={0}
      aria-label={`View details for ${hotel.name}`}
      className="bg-surface-1 rounded-xl border border-hairline p-4 hover:border-accent/40 hover:bg-accent/[0.07] active:bg-accent/[0.1] transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      onClick={handleSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(hotel);
        }
      }}
    >
      <div className="flex gap-3 items-start">
        {/* Thumbnail — same aspect ratio and slot sizing as Explore/Route cards. */}
        <div className="relative shrink-0 aspect-[4/3] w-20 sm:w-28 overflow-hidden rounded-lg bg-surface-2">
          {!showImg && (
            <span
              aria-hidden
              className="img-skeleton absolute inset-0"
              style={{ backgroundColor: "rgb(39 39 42 / 0.8)" }}
            />
          )}
          {showImg ? (
            <SmartImage
              src={url!}
              alt={hotel.name}
              onError={handleImgError}
              loading="lazy"
              sizes="112px"
              widths={[160, 320, 480]}
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
          ) : (
            <span
              aria-hidden
              className="absolute inset-0 grid place-items-center bg-surface-2 text-zinc-600"
            >
              <CategoryIcon kind="hotel" className="w-6 h-6 opacity-60" />
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center gap-3">
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-ink truncate group-hover:text-blue-300 transition-colors">
                {hotel.name}
              </h4>
              <p className="text-sm text-ink-muted mt-1 truncate">{hotel.address}</p>
            </div>
            <div className="text-right shrink-0 self-center">
              <div className="text-lg font-semibold leading-none text-blue-400">
                ${hotel.pricePerNight}
              </div>
              <div className="mt-1 text-xs text-ink-muted">/night</div>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-3">
            <div className="flex">
              {Array.from({ length: 5 }).map((_, i) => (
                <svg
                  key={i}
                  className={`w-3.5 h-3.5 ${i < hotel.stars ? "text-warn" : "text-zinc-700"}`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </div>
            {hotel.distanceFromCenter !== undefined && (
              <span className="text-xs text-ink-muted">{hotel.distanceFromCenter} km away</span>
            )}
            <AddToTripButton
              className="ml-auto"
              theme="dark"
              item={{
                name: hotel.name,
                category: "hotel",
                description: hotel.address,
                price: `$${hotel.pricePerNight}/night`,
                rating: hotel.stars,
                lat: hotel.lat,
                lng: hotel.lng,
              }}
            />
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            {hotel.amenities.slice(0, 4).map((a) => (
              <span
                key={a}
                className="px-2 py-1 bg-surface-2 border border-hairline text-ink-muted text-xs rounded-md"
              >
                {a}
              </span>
            ))}
            {hotel.amenities.length > 4 && (
              <span className="px-2 py-1 bg-surface-2 border border-hairline text-ink-faint text-xs rounded-md">
                +{hotel.amenities.length - 4}
              </span>
            )}
          </div>

          {hotel.phone && (
            <a
              href={`tel:${hotel.phone}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="inline-flex min-h-touch items-center gap-1 mt-2 rounded-md text-xs text-blue-400 hover:text-blue-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                />
              </svg>
              {hotel.phone}
            </a>
          )}
        </div>
      </div>
    </div>
  );
});
