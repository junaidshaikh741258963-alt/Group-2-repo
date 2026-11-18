"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { recMeta, type RecType, type Recommendation } from "@/lib/recommendations";
import { usePlaceImage } from "@/lib/placeImages";
import { savedPlaceKey } from "@/lib/savedPlaces";
import { activityBookingTarget, bookLinkProps, hotelBookingTarget } from "@/lib/bookingLinks";
import AddToTripButton from "@/components/ui/AddToTripButton";
import SavePlaceButton from "@/components/ui/SavePlaceButton";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";
import CardCarousel from "@/components/ui/CardCarousel";

/** "tile" is the photo-first discovery card; "row" is the list card with the
 *  thumbnail on the right. Both are the same data — just different densities. */
export type CardPresentation = "tile" | "row";

interface RecommendationCardProps {
  item: Recommendation;
  presentation?: CardPresentation;
  active?: boolean;
  hovered?: boolean;
  onClick?: () => void;
  onHover?: (id: string | null) => void;
  delay?: number;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** Opens the place detail sheet without leaving the chat. */
  onDetails?: () => void;
  /** Trip details for pre-filled booking hand-offs; omit when unknown. */
  bookContext?: { checkIn?: string; checkOut?: string; adults?: number; city?: string };
}

function PlaceholderArt({ kind }: { kind: RecType }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-zinc-800 text-zinc-600"
      aria-hidden
    >
      <CategoryIcon kind={kind} className="h-7 w-7" />
    </div>
  );
}

function PinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11Z"
      />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  );
}

function StarIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.4l-5.8 3 1.1-6.4L2.6 9.4l6.5-.9L12 2.6z" />
    </svg>
  );
}

function reviewCount(n?: number): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".0", "")}k`;
  return String(n);
}

const RecommendationCard = memo(function RecommendationCardInner({
  item,
  presentation = "tile",
  active = false,
  hovered = false,
  onClick,
  onHover,
  delay,
  selectable = false,
  selected = false,
  onSelect,
  onDetails,
  bookContext,
}: RecommendationCardProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const meta = recMeta(item.type);
  const { url: img, onImgError } = usePlaceImage(
    {
      name: item.name,
      type: item.type,
      image: item.image,
      lat: item.lat,
      lng: item.lng,
      city: item.city,
      // Chat/trip recommendation cards — spends the trip surface's Pixabay key.
      surface: "trip",
    },
    rootRef
  );
  // A dead URL is re-resolved by the hook's bounded retry; this local flag
  // only hides the frame between the error and the replacement's arrival.
  const showImg = Boolean(img) && img !== failedSrc;

  const handleImgError = useCallback(() => {
    setFailedSrc((prev) => prev ?? img ?? null);
    onImgError();
  }, [img, onImgError]);

  const hoverHandlers = {
    onMouseEnter: () => onHover?.(item.id),
    onMouseLeave: () => onHover?.(null),
  };

  const tripItem = useMemo(
    () => ({
      name: item.name,
      category: item.type,
      description: item.description,
      image: item.image,
      rating: item.rating,
      price: item.price,
      lat: item.lat,
      lng: item.lng,
      link: item.link,
    }),
    [
      item.name,
      item.type,
      item.description,
      item.image,
      item.rating,
      item.price,
      item.lat,
      item.lng,
      item.link,
    ]
  );

  const savedSnapshot = useMemo(
    () => ({
      type: item.type,
      name: item.name,
      lat: item.lat,
      lng: item.lng,
      city: item.city,
      rating: item.rating,
      reviews: item.reviews,
      price: item.price,
      image: item.image,
    }),
    [
      item.type,
      item.name,
      item.lat,
      item.lng,
      item.city,
      item.rating,
      item.reviews,
      item.price,
      item.image,
    ]
  );

  // Pre-filled hand-off to a real booking site. Hotels and ticketed
  // attractions only — restaurants/cafés are walked into, not booked here.
  const booking = useMemo(() => {
    if (item.type === "hotel") {
      return {
        target: hotelBookingTarget({
          name: item.name,
          city: bookContext?.city ?? item.city,
          checkIn: bookContext?.checkIn,
          checkOut: bookContext?.checkOut,
          adults: bookContext?.adults,
        }),
        label: "Availability",
        title: `Check dates and prices for ${item.name} on Booking.com`,
      };
    }
    if (item.type === "attraction") {
      return {
        target: activityBookingTarget({ name: item.name, city: bookContext?.city ?? item.city }),
        label: "Tickets",
        title: `Find tickets for ${item.name} on GetYourGuide`,
      };
    }
    return null;
  }, [
    item.type,
    item.name,
    item.city,
    bookContext?.city,
    bookContext?.checkIn,
    bookContext?.checkOut,
    bookContext?.adults,
  ]);

  const ratingText = reviewCount(item.reviews);
  const location = item.city?.trim() || meta.label;

  const saveButton = (
    <SavePlaceButton
      placeKey={savedPlaceKey(item.type, item.name)}
      name={item.name}
      place={savedSnapshot}
      appearance={presentation === "tile" ? "ghost" : "chip"}
    />
  );

  const tripButton = (
    <AddToTripButton
      item={tripItem}
      size="icon"
      appearance={presentation === "tile" ? "solid" : "chip"}
    />
  );

  const selectPill = selectable ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        selected
          ? "bg-white text-zinc-900"
          : "border border-white/[0.14] text-zinc-300 hover:border-white/30 hover:text-white"
      }`}
    >
      {selected && (
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={3}
            d="m5 13 4 4L19 7"
          />
        </svg>
      )}
      {selected ? "Selected" : "Choose"}
    </button>
  ) : null;

  if (presentation === "row") {
    return (
      <div
        ref={rootRef}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.();
          }
        }}
        {...hoverHandlers}
        data-place-card-id={item.id}
        style={delay ? { animationDelay: `${delay}ms` } : undefined}
        className={`group flex w-full cursor-pointer items-start gap-3 py-3 text-left transition-colors animate-card-in focus-visible:outline-none ${
          active || hovered ? "bg-white/[0.03]" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-ink">
              {item.name}
            </h3>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-zinc-500">
            {item.rating != null && (
              <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-amber-300">
                <StarIcon className="h-2.5 w-2.5" />
                {item.rating.toFixed(1)}
                {ratingText && <span className="font-normal text-zinc-500">({ratingText})</span>}
              </span>
            )}
            <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-zinc-600" aria-hidden />
            <span className="truncate">{meta.label}</span>
            <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-zinc-600" aria-hidden />
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <PinIcon className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{location}</span>
            </span>
          </div>
          {item.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400 [overflow-wrap:anywhere]">
              {item.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {onDetails && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDetails();
                }}
                className="inline-flex h-7 items-center rounded-full border border-white/[0.12] px-2.5 text-2xs font-medium text-zinc-300 transition-colors hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                View details
              </button>
            )}
            {booking && (
              <a
                {...bookLinkProps(booking.target, booking.title)}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-7 items-center rounded-full bg-white/[0.06] px-2.5 text-2xs font-medium text-zinc-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                {booking.label}
                <span className="ml-1 text-zinc-500" aria-hidden>
                  ↗
                </span>
              </a>
            )}
            {selectPill}
            {item.price && <span className="text-2xs text-zinc-500">{item.price}</span>}
          </div>
        </div>

        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-zinc-800">
          {showImg ? (
            <SmartImage
              src={img!}
              alt={item.name}
              onError={handleImgError}
              sizes="96px"
              widths={[320, 640]}
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
          ) : (
            <PlaceholderArt kind={item.type} />
          )}
          <div className="absolute right-1 top-1 flex items-center gap-1">
            {saveButton}
            {tripButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      data-place-card-id={item.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      {...hoverHandlers}
      className="group flex w-full cursor-pointer flex-col text-left animate-card-in focus-visible:outline-none"
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      <div
        data-card-image
        className={`relative aspect-square w-full overflow-hidden rounded-xl bg-zinc-800 transition-shadow ${
          active ? "ring-2 ring-white/80" : hovered ? "ring-1 ring-white/30" : ""
        }`}
      >
        {showImg ? (
          <SmartImage
            src={img!}
            alt={item.name}
            onError={handleImgError}
            sizes="160px"
            widths={[320, 640]}
            className="h-full w-full object-cover transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-105"
          />
        ) : (
          <PlaceholderArt kind={item.type} />
        )}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        />
        <div className="absolute left-2 top-2">{saveButton}</div>
        <div className="absolute right-2 top-2">{tripButton}</div>
        {onDetails && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDetails();
            }}
            title={`More about ${item.name}`}
            aria-label={`More about ${item.name}`}
            className="absolute bottom-2 left-2 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white/90 shadow-sm shadow-black/30 backdrop-blur-sm transition-colors hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" d="M12 11v6M12 7.6h.01" />
            </svg>
          </button>
        )}
        {selectable && (
          <span className="absolute bottom-2 right-2">{selectPill}</span>
        )}
      </div>

      <div className="mt-2 min-w-0 px-0.5">
        <h3 className="truncate text-sm font-semibold leading-snug text-ink">{item.name}</h3>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-zinc-500">
          <PinIcon className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{location}</span>
        </p>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs">
          {item.rating != null ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-amber-300">
              <StarIcon className="h-2.5 w-2.5" />
              {item.rating.toFixed(1)}
            </span>
          ) : (
            <span className="shrink-0 text-zinc-500">{meta.label}</span>
          )}
          {ratingText && <span className="truncate text-zinc-500">({ratingText})</span>}
          {item.price && (
            <>
              <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-zinc-600" aria-hidden />
              <span className="truncate text-zinc-400">{item.price}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export default RecommendationCard;

/** One cell in the horizontal strip. Memoized so hover/focus changes on one
 *  card don't re-render every sibling. */
const RecommendationRow = memo(function RecommendationRow({
  item,
  presentation,
  active,
  hovered,
  delay,
  selectable,
  selected,
  onSelect,
  onFocus,
  onHover,
  onDetails,
}: {
  item: Recommendation;
  presentation?: CardPresentation;
  active: boolean;
  hovered: boolean;
  delay: number;
  selectable: boolean;
  selected: boolean;
  onSelect?: (item: Recommendation) => void;
  onFocus?: (id: string) => void;
  onHover?: (id: string | null) => void;
  onDetails?: (item: Recommendation) => void;
}) {
  const handleSelect = useCallback(() => onSelect?.(item), [onSelect, item]);
  const handleClick = useCallback(() => onFocus?.(item.id), [onFocus, item.id]);
  const handleDetails = useCallback(() => onDetails?.(item), [onDetails, item]);
  // Computed widths: three photo tiles fit the reply column with a sliver of
  // the next card peeking in, so the row reads as scrollable without arrows.
  const basis =
    presentation === "row"
      ? "w-full"
      : "basis-[calc((100%_-_8px)/2.15)] @sm:basis-[calc((100%_-_16px)/3.1)]";
  return (
    <div className={`flex shrink-0 snap-start ${basis}`}>
      <RecommendationCard
        item={item}
        presentation={presentation}
        active={active}
        hovered={hovered}
        delay={delay}
        selectable={selectable}
        selected={selected}
        onSelect={handleSelect}
        onClick={handleClick}
        onHover={onHover}
        onDetails={onDetails ? handleDetails : undefined}
      />
    </div>
  );
});

export function RecommendationCards({
  items,
  presentation = "tile",
  layout = "row",
  activeId,
  hoverId,
  onFocus,
  onHover,
  selectableType,
  onSelect,
  selectedName,
  onDetails,
}: {
  items: Recommendation[];
  presentation?: CardPresentation;
  /** "grid" keeps every option visible; the default row is a swipeable strip.
   *  "list" stacks full-width row cards (restaurants, stays). */
  layout?: "row" | "grid" | "list";
  activeId?: string | null;
  hoverId?: string | null;
  onFocus?: (id: string) => void;
  onHover?: (id: string | null) => void;
  selectableType?: RecType | null;
  onSelect?: (item: Recommendation) => void;
  selectedName?: string | null;
  onDetails?: (item: Recommendation) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="@container">
      <CardsViewport
        items={items}
        presentation={presentation}
        layout={layout}
        activeId={activeId}
        hoverId={hoverId}
        onFocus={onFocus}
        onHover={onHover}
        selectableType={selectableType}
        onSelect={onSelect}
        selectedName={selectedName}
        onDetails={onDetails}
      />
    </div>
  );
}

/** Card strip for a category row — scrolling, edge arrows and the hidden
 *  scrollbar live in the shared CardCarousel. No ancestor may clip it: the
 *  carousel's scroller is the only overflow boundary. */
function CardsViewport({
  items,
  presentation = "tile",
  layout = "row",
  activeId,
  hoverId,
  onFocus,
  onHover,
  selectableType,
  onSelect,
  selectedName,
  onDetails,
}: {
  items: Recommendation[];
  presentation?: CardPresentation;
  layout?: "row" | "grid" | "list";
  activeId?: string | null;
  hoverId?: string | null;
  onFocus?: (id: string) => void;
  onHover?: (id: string | null) => void;
  selectableType?: RecType | null;
  onSelect?: (item: Recommendation) => void;
  selectedName?: string | null;
  onDetails?: (item: Recommendation) => void;
}) {
  const cards = items.map((item, i) => {
    const selectable = Boolean(selectableType) && item.type === selectableType;
    const selected = selectable && Boolean(selectedName) && selectedName!.includes(item.name);
    const active = activeId === item.id;
    const hovered = hoverId === item.id;
    const delay = Math.min(i, 6) * 55;
    if (layout === "grid" || layout === "list") {
      return (
        <RecommendationCard
          key={item.id}
          item={item}
          presentation={presentation}
          active={active}
          hovered={hovered}
          delay={delay}
          selectable={selectable}
          selected={selected}
          onSelect={selectable ? () => onSelect?.(item) : undefined}
          onClick={() => onFocus?.(item.id)}
          onHover={onHover}
          onDetails={onDetails ? () => onDetails(item) : undefined}
        />
      );
    }
    return (
      <RecommendationRow
        key={item.id}
        item={item}
        presentation={presentation}
        active={active}
        hovered={hovered}
        delay={delay}
        selectable={selectable}
        selected={selected}
        onSelect={onSelect}
        onFocus={onFocus}
        onHover={onHover}
        onDetails={onDetails}
      />
    );
  });

  if (layout === "grid") {
    return (
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-3 @3xl:grid-cols-4">{cards}</div>
    );
  }

  if (layout === "list") {
    return <div className="divide-y divide-white/[0.06]">{cards}</div>;
  }

  return (
    <CardCarousel className="gap-2 py-0.5" label={items[0]?.type}>
      {cards}
    </CardCarousel>
  );
}
