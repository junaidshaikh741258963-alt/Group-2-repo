"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { recMeta } from "@/lib/recommendations";
import { usePlaceImage } from "@/lib/placeImages";
import { fetchPlaceGallery, MAX_GALLERY_IMAGES } from "@/lib/placeGallery";
import { usePlaceArea } from "@/lib/placeArea";
import { savedPlaceKey, useSavedPlace } from "@/lib/savedPlaces";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";
import AddToTripButton from "@/components/ui/AddToTripButton";
import SavePlaceButton from "@/components/ui/SavePlaceButton";
import { HeartIcon, PlaceRating } from "@/components/ui/PlaceMeta";
import type { MapMarkerData } from "@/components/map/MapView";

interface MapCardProps {
  marker: MapMarkerData;
  /** Position in the ordered route when a route line is drawn. */
  stopNumber?: number;
  /** True while the card plays its close animation (fade + scale out). */
  closing?: boolean;
  /** MapView's ref — it positions the card and watches it for resizes. */
  hostRef: React.RefObject<HTMLDivElement | null>;
  onEnter: (id: string) => void;
  onLeave: (id: string) => void;
  /** Re-focus the place: keeps chat and map pointing at the same card. */
  onSelect: (id: string) => void;
  /** Opens the full place window (photo gallery + everything else). */
  onOpenDetails: (id: string) => void;
  /** False when the parent has no place window — hides the details actions. */
  canOpenDetails?: boolean;
}

/** Shared empty list: "no gallery fetched for this place yet". */
const EMPTY_URLS: string[] = [];

/** One carousel frame. A dead URL degrades to category art instead of a hole.
 *  Uses SmartImage (not a raw <img>) so frames ride the /api/img proxy — no
 *  Pixabay hotlinking, plus the shared decode-once + fade-in behaviour. */
const Slide = memo(function Slide({
  src,
  alt,
  eager,
  onFail,
}: {
  src: string;
  alt: string;
  eager: boolean;
  /** Wired for the main slide: a dead URL re-resolves once (see usePlaceImage). */
  onFail?: () => void;
}) {
  return (
    <div className="map-card-slide">
      <SmartImage
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        sizes="300px"
        className="map-card-slide-img"
        onError={onFail}
        fallback={
          <div className="map-card-slide-empty h-full w-full" aria-hidden="true" />
        }
      />
    </div>
  );
});

/**
 * The place card that opens beside a pin: photo carousel on top, then name +
 * rating, category, city/region, a three-line description and a saved-by line.
 * ~300px wide, dark, with a pointer aimed at the pin it belongs to.
 *
 * Images resolve only while this card is mounted (it mounts when opened):
 * the card's own image comes from the cache-first lookup, extra frames from
 * the free Wikipedia gallery.
 */
const MapCard = memo(function MapCard({
  marker,
  stopNumber,
  closing = false,
  hostRef,
  onEnter,
  onLeave,
  onSelect,
  onOpenDetails,
  canOpenDetails = true,
}: MapCardProps) {
  const meta = recMeta(marker.kind);
  const { url: img, onImgError } = usePlaceImage(
    {
      name: marker.label,
      type: marker.kind,
      image: marker.image,
      lat: marker.lat,
      lng: marker.lng,
      city: marker.city,
      // Map popups ride with the trip surface's Pixabay key.
      surface: "trip",
    },
    hostRef
  );

  /* Extra carousel frames, fetched lazily the moment the card mounts. The
     pair is keyed by place so switching markers can never show the previous
     place's gallery — no state reset inside the effect. */
  const [gallery, setGallery] = useState<{ for: string; urls: string[] }>({
    for: "",
    urls: [],
  });
  useEffect(() => {
    let alive = true;
    fetchPlaceGallery(marker.label).then((urls) => {
      if (alive && urls.length > 0) setGallery({ for: marker.label, urls });
    });
    return () => {
      alive = false;
    };
  }, [marker.label]);
  const galleryUrls = gallery.for === marker.label ? gallery.urls : EMPTY_URLS;

  const slides = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (url?: string | null) => {
      if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    };
    add(img);
    for (const url of galleryUrls) add(url);
    return out.slice(0, MAX_GALLERY_IMAGES);
  }, [img, galleryUrls]);

  /* ————— Carousel ————— */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [rawIndex, setRawIndex] = useState(0);
  // Derived clamp: the slide count can shrink under the thumb (a dead URL
  // drops out), which a render-time read handles without an effect.
  const index = Math.min(rawIndex, Math.max(0, slides.length - 1));

  /* Coalesced to one read per frame: a trackpad can fire scroll events many
     times per frame, and each one here reads `clientWidth` (a layout metric)
     and schedules a React update — for a value that only changes four times
     over a whole swipe. */
  const carouselRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(carouselRaf.current), []);

  const handleScroll = () => {
    if (carouselRaf.current) return;
    carouselRaf.current = requestAnimationFrame(() => {
      carouselRaf.current = 0;
      const el = scrollerRef.current;
      if (!el) return;
      const next = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
      setRawIndex((prev) => (prev === next ? prev : Math.max(0, next)));
    });
  };
  const goTo = (next: number) => {
    const el = scrollerRef.current;
    setRawIndex(next);
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: next * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };

  /* ————— City / region line ————— */
  const reverseArea = usePlaceArea(marker.lat, marker.lng, !marker.city);
  const area = marker.city || reverseArea || null;

  /* ————— Saved-by footer: only ever shown once it is above zero ————— */
  const placeKey = savedPlaceKey(marker.kind, marker.label);
  const saved = useSavedPlace(placeKey);
  const savedCount = saved ? 1 : 0;

  const tripItem = useMemo(
    () => ({
      name: marker.label,
      category: marker.kind,
      description: marker.description,
      image: marker.image,
      rating: marker.rating,
      price: marker.price,
      lat: marker.lat,
      lng: marker.lng,
      link: marker.link,
    }),
    [
      marker.label,
      marker.kind,
      marker.description,
      marker.image,
      marker.rating,
      marker.price,
      marker.lat,
      marker.lng,
      marker.link,
    ]
  );

  // First tap keeps the map/chat in sync; the details sheet is behind the ⓘ.
  const activate = () => onSelect(marker.id);

  return (
    <article
      ref={hostRef}
      className={`map-card map-card-side-right${closing ? " is-closing" : ""}`}
      aria-label={`${marker.label} place card`}
      onMouseEnter={() => onEnter(marker.id)}
      onMouseLeave={() => onLeave(marker.id)}
    >
      <span className="map-card-pointer" aria-hidden="true" />
      <div
        role="button"
        tabIndex={0}
        aria-label={`${marker.label} on the map`}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        className="map-card-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
      >
        <div className="map-card-media">
          <div
            ref={scrollerRef}
            onScroll={handleScroll}
            className="map-card-slides"
            aria-label={`${marker.label} photos`}
          >
            {slides.length > 0 ? (
              slides.map((src, i) => (
                <Slide
                  key={src}
                  src={src}
                  eager={i < 2}
                  alt={`${marker.label} photo ${i + 1}`}
                  onFail={i === 0 ? onImgError : undefined}
                />
              ))
            ) : (
              <div className="map-card-slide map-card-slide-empty">
                <CategoryIcon kind={marker.kind} className="w-10 h-10 text-zinc-600" />
              </div>
            )}
          </div>

          {slides.length > 1 && (
            <>
              <button
                type="button"
                className="map-card-arrow map-card-arrow--prev"
                aria-label="Previous photo"
                onClick={(e) => {
                  e.stopPropagation();
                  goTo((index - 1 + slides.length) % slides.length);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="m14.5 18-6-6 6-6"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="map-card-arrow map-card-arrow--next"
                aria-label="Next photo"
                onClick={(e) => {
                  e.stopPropagation();
                  goTo((index + 1) % slides.length);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="m9.5 6 6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          )}

          <div className="map-card-actions">
            <SavePlaceButton
              placeKey={placeKey}
              name={marker.label}
              place={{
                type: marker.kind,
                name: marker.label,
                lat: marker.lat,
                lng: marker.lng,
                city: marker.city,
                rating: marker.rating,
                reviews: marker.reviews,
                price: marker.price,
                image: marker.image,
              }}
              className="map-card-action"
            />
            <AddToTripButton size="icon" theme="dark" item={tripItem} className="map-card-action" />
          </div>

          {slides.length > 1 && (
            <div className="map-card-dots">
              {slides.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  className={`map-card-dot${i === index ? " is-on" : ""}`}
                  aria-label={`Show photo ${i + 1} of ${slides.length}`}
                  aria-current={i === index}
                  onClick={(e) => {
                    e.stopPropagation();
                    goTo(i);
                  }}
                />
              ))}
            </div>
          )}

          {canOpenDetails && (
            <button
              type="button"
              className="map-card-info"
              title="More info"
              aria-label={`More information about ${marker.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetails(marker.id);
              }}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M12 10.6v6"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="7.6" r="1.15" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>

        <div className="map-card-body">
          <div className="map-card-head">
            <h3 className="map-card-name">{marker.label}</h3>
            {marker.rating != null && (
              <PlaceRating
                rating={marker.rating}
                reviews={marker.reviews}
                className="map-card-rating"
              />
            )}
          </div>

          <div className="map-card-cat">
            <CategoryIcon kind={marker.kind} className="h-3.5 w-3.5 shrink-0" />
            <span>{meta.label}</span>
            {marker.durationText && (
              <span
                className="ml-auto shrink-0 text-2xs font-medium tabular-nums text-ink-muted"
                title={marker.durationTitle}
              >
                {marker.durationText} on site
              </span>
            )}
          </div>

          {area && <div className="map-card-place">{area}</div>}

          {marker.description && <p className="map-card-desc">{marker.description}</p>}

          {savedCount > 0 && (
            <div className="map-card-saved">
              <HeartIcon className="map-card-heart" />
              <span>
                Saved by {savedCount} {savedCount === 1 ? "person" : "people"}
              </span>
            </div>
          )}

          {/* Explicit CTA: opens this place's full window (photos, hours,
              reviews, directions). Only rendered when the parent can open it. */}
          {canOpenDetails && (
            <button
              type="button"
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-semibold text-zinc-900 transition-colors duration-150 hover:bg-zinc-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetails(marker.id);
              }}
            >
              View details
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {stopNumber != null && <span className="map-stop map-card-stop">{stopNumber}</span>}
    </article>
  );
});

export default MapCard;
