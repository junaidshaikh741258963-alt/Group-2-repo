"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import SmartImage from "@/components/ui/SmartImage";
import { useInView } from "@/lib/useInView";

export interface PlacePhoto {
  url: string;
  thumb: string;
  section: string;
  source?: string;
}

/* ————— Shared chrome ————— */

/* Glass pill chrome, shared by the header icons and the lightbox arrows.
   The base deliberately carries no size or position: Tailwind emits
   `.absolute` *before* `.relative`, so one class list holding both would
   silently keep `relative` — which is exactly what knocked the prev/next
   arrows into a stack at the left edge. Each call site picks one position
   and one size. */
const GLASS_BASE =
  "grid shrink-0 place-items-center rounded-full border border-white/15 bg-black/45 text-zinc-200 backdrop-blur-sm transition hover:border-white/35 hover:bg-black/75 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70";

/** Absolutely-placed nav arrow over a photo; the call site adds `left-*`
 *  or `right-*` (never `relative` — it would win over `absolute`). */
const GLASS_NAV_BTN = `${GLASS_BASE} absolute top-1/2 z-10 h-11 w-11 -translate-y-1/2 hit-44-sm`;

export function XIcon({ className = "h-4.5 w-4.5" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export function ChevronIcon({
  dir,
  className = "h-5 w-5",
}: {
  dir: "left" | "right";
  className?: string;
}) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={dir === "left" ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"}
      />
    </svg>
  );
}

export function GridIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"
      />
    </svg>
  );
}

function ExpandIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
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
  );
}

function PhotoOffIcon({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M4 7h3l1.6-2h6.8L17 7h3v12H4zM12 16a3 3 0 100-6 3 3 0 000 6z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3 3l18 18" />
    </svg>
  );
}

export function ExternalIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M14 5h5v5M19 5l-8 8M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"
      />
    </svg>
  );
}

/* ————— Crossfading image layers ————— */

/**
 * Keeps the last two requested URLs mounted so switching photos crossfades
 * instead of flashing an empty frame while the next image decodes.
 */
export function usePhotoLayers(url?: string): string[] {
  const [layers, setLayers] = useState<string[]>(() => (url ? [url] : []));

  // Keep the previous frame mounted (so the swap crossfades) while the next
  // image decodes. Adjusted during render — the layer list is derived from the
  // requested url, so an effect only added a stale frame of latency.
  const top = layers[layers.length - 1];
  if (url && url !== top) {
    setLayers((prev) => (prev[prev.length - 1] === url ? prev : [...prev.slice(-1), url]));
  }

  return url ? layers : [];
}

export function PhotoLayers({
  urls,
  alt,
  imgClassName = "h-full w-full object-cover",
  eager = true,
  onError,
  sizes,
  widths,
}: {
  urls: string[];
  alt: string;
  imgClassName?: string;
  eager?: boolean;
  onError?: (url: string) => void;
  /** srcset hint — fullscreen callers pass `100vw` so a large rendition wins. */
  sizes?: string;
  /** srcset widths — fullscreen callers offer up to 1600 px. */
  widths?: number[];
}) {
  return (
    <>
      {urls.map((u, i) => {
        const top = i === urls.length - 1;
        return (
          <div
            key={u}
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
              top ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <SmartImage
              src={u}
              alt={alt}
              className={imgClassName}
              loading={top && eager ? "eager" : "lazy"}
              fetchPriority={top && eager ? "high" : "low"}
              sizes={sizes}
              widths={widths}
              onError={() => onError?.(u)}
            />
          </div>
        );
      })}
    </>
  );
}

/* ————— Full gallery ————— */

interface PhotoGalleryProps {
  photos: PlacePhoto[];
  placeName: string;
  onClose: () => void;
  onOpenPhoto: (index: number) => void;
  closing?: boolean;
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-2 pt-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
        active
          ? "border-blue-400 text-white"
          : "border-transparent text-zinc-500 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * One gallery cell. `cover` renders the leading photo full-bleed across the
 * grid; every other cell is an aspect-locked tile, so widths stay fluid at any
 * viewport instead of collapsing into fixed-height strips.
 *
 * The photo is only mounted once the tile is near the viewport. A gallery
 * grid of 24 photos used to ask for 9 of them at once — nine parallel
 * downloads through the proxy, which is exactly how the upstream starts
 * throttling and half the tiles stay blank.
 */
function GalleryTile({
  photo,
  photoIndex,
  total,
  placeName,
  cover = false,
  onClick,
}: {
  photo: PlacePhoto;
  photoIndex: number;
  total: number;
  placeName: string;
  cover?: boolean;
  onClick: () => void;
}) {
  const hostRef = useRef<HTMLButtonElement>(null);
  const near = useInView(hostRef, "400px 0px");
  return (
    <button
      ref={hostRef}
      type="button"
      onClick={onClick}
      className={`group relative w-full overflow-hidden bg-zinc-900 ring-1 ring-white/[0.08] transition duration-200 hover:ring-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/80 ${
        cover
          ? "aspect-[16/9] rounded-xl md:aspect-[2.15/1] md:max-h-[52vh]"
          : "aspect-[4/3] rounded-lg"
      }`}
      aria-label={`Open photo ${photoIndex + 1} of ${total} · ${placeName}`}
    >
      {near ? (
        <SmartImage
          src={photo.thumb}
          alt={`${placeName} photo ${photoIndex + 1}`}
          className="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03]"
          priority={cover}
          sizes={cover ? "(max-width: 768px) 92vw, 60vw" : "(max-width: 768px) 46vw, 30vw"}
          fallback={
            <span className="absolute inset-0 grid place-items-center bg-zinc-900 text-zinc-700">
              <PhotoOffIcon className="h-8 w-8" />
            </span>
          }
        />
      ) : (
        <span className="img-skeleton absolute inset-0" aria-hidden />
      )}
      <span
        className={`pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-black/5 to-transparent transition-opacity duration-200 ${
          cover ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      />
      <span className="pointer-events-none absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100">
        <ExpandIcon className="h-3.5 w-3.5" />
      </span>
      <span
        className={`pointer-events-none absolute inset-x-3 bottom-2.5 flex items-end justify-between gap-2 text-2xs font-medium text-white transition-opacity duration-200 ${
          cover ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <span className="min-w-0 truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          {photo.section && photo.section !== "Photo" ? photo.section : ""}
        </span>
        {cover && (
          <span className="shrink-0 tabular-nums text-white/65 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            {photoIndex + 1} / {total}
          </span>
        )}
      </span>
    </button>
  );
}

const GRID_CLS = "grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-3 xl:grid-cols-4";

export function PhotoGallery({
  photos,
  placeName,
  onClose,
  onOpenPhoto,
  closing = false,
}: PhotoGalleryProps) {
  const [filter, setFilter] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    photos.forEach((photo, i) => {
      const key = photo.section?.trim() || "Photos";
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    });
    return Array.from(map.entries());
  }, [photos]);

  const indices = filter
    ? (groups.find(([key]) => key === filter)?.[1] ?? [])
    : photos.map((_, i) => i);
  const showFilters = groups.length > 1;
  const showSections = groups.length > 1;
  const sections = showSections ? groups.filter(([key]) => filter === null || key === filter) : [];

  const countLabel = filter ? `${indices.length} of ${photos.length}` : `${photos.length} photos`;

  return createPortal(
    <div
      className={`fixed inset-0 z-[110] flex flex-col bg-zinc-950 text-ink ${
        closing ? "animate-exit pointer-events-none" : "animate-overlay-in"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={`All photos of ${placeName}`}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] bg-zinc-950/90 px-4 py-3 backdrop-blur-xl md:px-8 md:py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-white md:text-xl">
            {placeName}
          </h2>
          <div className="mt-0.5 flex items-center gap-2 text-2xs font-medium text-zinc-500">
            <GridIcon className="h-3.5 w-3.5 text-zinc-600" />
            <span>Photo gallery</span>
            <span className="h-0.5 w-0.5 rounded-full bg-zinc-700" />
            <span className="tabular-nums text-zinc-400">{countLabel}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3 text-2xs font-semibold text-zinc-200 transition hover:border-white/30 hover:bg-white/[0.08] hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
          aria-label="Close photo gallery"
        >
          <XIcon className="h-4 w-4" />
          <span className="hidden md:inline">Close</span>
        </button>
      </header>

      {showFilters && (
        <div className="dark-scroll flex shrink-0 gap-6 overflow-x-auto border-b border-white/[0.06] px-4 py-1 md:px-8">
          <FilterChip
            label={`All · ${photos.length}`}
            active={filter === null}
            onClick={() => setFilter(null)}
          />
          {groups.map(([key, list]) => (
            <FilterChip
              key={key}
              label={`${key} · ${list.length}`}
              active={filter === key}
              onClick={() => setFilter(key)}
            />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain dark-scroll">
        <div className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-4 md:px-8 md:pt-7">
          {indices.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-sm text-ink-faint">
              No photos in this section.
            </div>
          ) : showSections ? (
            sections.map(([key, list], si) => {
              const isFirst = si === 0;
              const rest = isFirst ? list.slice(1) : list;
              return (
                <section key={key} className={si === 0 ? "" : "mt-9 md:mt-11"}>
                  <div className="mb-3 flex items-baseline gap-2.5">
                    <h3 className="shrink-0 text-sm font-semibold tracking-tight text-zinc-200">
                      {key}
                    </h3>
                    <span className="shrink-0 text-2xs font-medium tabular-nums text-zinc-600">
                      {list.length}
                    </span>
                    <span className="h-px flex-1 bg-white/[0.07]" />
                  </div>
                  <div className={GRID_CLS}>
                    {isFirst && (
                      <div className="col-span-full">
                        <GalleryTile
                          photo={photos[list[0]]}
                          photoIndex={list[0]}
                          total={photos.length}
                          placeName={placeName}
                          cover
                          onClick={() => onOpenPhoto(list[0])}
                        />
                      </div>
                    )}
                    {rest.map((photoIndex) => (
                      <GalleryTile
                        key={`${photos[photoIndex].url}-${photoIndex}`}
                        photo={photos[photoIndex]}
                        photoIndex={photoIndex}
                        total={photos.length}
                        placeName={placeName}
                        onClick={() => onOpenPhoto(photoIndex)}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          ) : (
            <div className={GRID_CLS}>
              <div className="col-span-full">
                <GalleryTile
                  photo={photos[indices[0]]}
                  photoIndex={indices[0]}
                  total={photos.length}
                  placeName={placeName}
                  cover
                  onClick={() => onOpenPhoto(indices[0])}
                />
              </div>
              {indices.slice(1).map((photoIndex) => (
                <GalleryTile
                  key={`${photos[photoIndex].url}-${photoIndex}`}
                  photo={photos[photoIndex]}
                  photoIndex={photoIndex}
                  total={photos.length}
                  placeName={placeName}
                  onClick={() => onOpenPhoto(photoIndex)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ————— Lightbox ————— */

/** srcset widths the fullscreen viewer offers (all /api/img-allowed). */
const VIEWER_WIDTHS = [640, 960, 1280, 1600];

/** Thumbnail renditions — a strip thumbnail is 112 px wide, so 320 is plenty. */
const THUMB_WIDTHS = [160, 320, 480];

/** How many strip thumbnails are mounted at once. */
const THUMB_WINDOW = 8;

/** Keep-alive list so warming `Image`s aren't collected mid-fetch. */
const warmKeepAlive: HTMLImageElement[] = [];

/** The proxy width this viewport's srcset would pick — one warm, right file. */
function viewerProxyWidth(): number {
  const need = Math.round(
    (typeof window !== "undefined" ? window.innerWidth : 1280) *
      (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
  );
  for (const w of VIEWER_WIDTHS) if (w >= need) return w;
  return 1600;
}

interface LightboxProps {
  photos: PlacePhoto[];
  placeName: string;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  closing?: boolean;
}

export function Lightbox({
  photos,
  placeName,
  index,
  onIndexChange,
  onClose,
  closing = false,
}: LightboxProps) {
  const total = photos.length;
  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  const photo = total > 0 ? photos[safeIndex] : undefined;

  const stripRef = useRef<HTMLDivElement>(null);
  const stripEndRef = useRef<HTMLSpanElement>(null);
  const touchX = useRef<number | null>(null);
  const lastSwipe = useRef(0);
  const [failedIndex, setFailedIndex] = useState<number | null>(null);
  /**
   * How many thumbnails are mounted. The strip grows as it is scrolled, so a
   * long gallery never asks the proxy for every photo at once.
   */
  const [thumbCount, setThumbCount] = useState(THUMB_WINDOW);
  const urls = usePhotoLayers(photo?.url);

  /**
   * The thumbnails that are mounted: the current window plus the selected
   * photo and its two neighbours (always eager, so navigation is instant).
   */
  const thumbIndices = useMemo(() => {
    const set = new Set<number>();
    // Without an observer there is no scrolling to grow the window by, so the
    // whole strip is mounted at once.
    const window = typeof IntersectionObserver === "undefined" ? total : thumbCount;
    for (let i = 0; i < Math.min(total, window); i++) set.add(i);
    if (total > 0) {
      for (const delta of [-1, 0, 1]) {
        set.add((safeIndex + delta + total) % total);
      }
    }
    return [...set].sort((a, b) => a - b);
  }, [total, thumbCount, safeIndex]);

  // Grow the window when the end of the strip comes into view.
  useEffect(() => {
    const el = stripEndRef.current;
    if (!el || thumbCount >= total) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setThumbCount((c) => Math.min(total, c + THUMB_WINDOW));
        }
      },
      { root: stripRef.current, rootMargin: "200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [thumbCount, total]);

  // The index that failed to decode — derived, so navigating resets nothing.
  const failed = failedIndex === safeIndex;

  const step = useCallback(
    (delta: number) => {
      if (total < 2) return;
      onIndexChange((safeIndex + delta + total) % total);
    },
    [total, safeIndex, onIndexChange]
  );

  const jump = useCallback(
    (next: number) => {
      onIndexChange(next);
    },
    [onIndexChange]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "Home") {
        e.preventDefault();
        jump(0);
      } else if (e.key === "End") {
        e.preventDefault();
        jump(total - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, jump, total]);

  // Warm the neighbours so swiping lands on an already-decoded frame. The
  // warm goes through /api/img at the exact width the viewer's srcset will
  // ask for (a raw-URL warm would fetch a different file and never be reused).
  useEffect(() => {
    if (total < 2) return;
    const width = viewerProxyWidth();
    [-1, 1].forEach((delta) => {
      const neighbour = photos[(safeIndex + delta + total) % total];
      if (neighbour && /^https?:\/\//i.test(neighbour.url)) {
        const img = new Image();
        img.decoding = "async";
        img.src = `/api/img?url=${encodeURIComponent(neighbour.url)}&w=${width}`;
        warmKeepAlive.push(img);
        if (warmKeepAlive.length > 8) warmKeepAlive.shift();
      }
    });
  }, [safeIndex, total, photos]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const thumb = strip.querySelectorAll("button")[safeIndex];
    if (!thumb) return;
    const target = thumb.offsetLeft - (strip.clientWidth - thumb.clientWidth) / 2;
    strip.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [safeIndex]);

  if (!photo) return null;

  // Clicking the photo itself keeps the viewer open (it's the swipe target);
  // the letterbox around it behaves like the background and closes. With the
  // img now filling the frame (`h-full w-full object-contain`), the content
  // box has to be recomputed from the natural size — `closest("img")` alone
  // would have swallowed every background click too.
  const closesOnBackground = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button,a")) return false;
    if (target.tagName !== "IMG") return true;
    const img = target as HTMLImageElement;
    if (!img.naturalWidth || !img.naturalHeight) return false;
    const box = img.getBoundingClientRect();
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const onPhoto =
      x >= (box.width - w) / 2 &&
      x <= (box.width + w) / 2 &&
      y >= (box.height - h) / 2 &&
      y <= (box.height + h) / 2;
    return !onPhoto;
  };

  return createPortal(
    <div
      className={`fixed inset-0 z-[120] flex flex-col bg-[#050506] text-ink ${
        closing ? "animate-exit pointer-events-none" : "animate-overlay-in"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${safeIndex + 1} of ${total} · ${placeName}`}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] bg-black/80 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight text-white">
            {placeName}
          </div>
          <div className="truncate text-2xs text-zinc-500">
            {[photo.section && photo.section !== "Photo" ? photo.section : "Gallery", photo.source]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <span className="shrink-0 text-2xs font-medium tabular-nums text-zinc-400">
          {safeIndex + 1} <span className="text-zinc-600">/ {total}</span>
        </span>
        <a
          href={photo.url}
          target="_blank"
          rel="noreferrer"
          title="Open original"
          aria-label="Open original photo in a new tab"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
        >
          <ExternalIcon />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-3 text-2xs font-semibold text-zinc-200 transition hover:border-white/30 hover:bg-white/[0.09] hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
          aria-label="Close photo viewer"
        >
          <XIcon className="h-4 w-4" />
          <span className="hidden md:inline">Close</span>
        </button>
      </header>

      <div
        className="relative min-h-0 flex-1 touch-pan-y select-none overflow-hidden"
        onClick={(e) => {
          if (Date.now() - lastSwipe.current < 400) return;
          if (closesOnBackground(e)) onClose();
        }}
        onTouchStart={(e) => {
          touchX.current = e.changedTouches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          if (start == null) return;
          const dx = (e.changedTouches[0]?.clientX ?? start) - start;
          touchX.current = null;
          if (Math.abs(dx) < 10) return;
          lastSwipe.current = Date.now();
          if (Math.abs(dx) > 48) step(dx > 0 ? -1 : 1);
        }}
      >
        <PhotoLayers
          urls={urls}
          alt={`${placeName} photo ${safeIndex + 1}`}
          /* Fills the viewer instead of rendering at intrinsic (thumbnail-ish)
             size in the middle of it: the frame is the flex-1 area between the
             header and the thumbnail strip, capped at 78vh on desktop, and
             object-contain keeps the letterbox. `sizes=100vw` + the wide
             srcset make the browser pick a fullscreen rendition rather than
             the 640 px card one. */
          imgClassName="h-full w-full max-h-[78vh] object-contain"
          sizes="100vw"
          widths={VIEWER_WIDTHS}
          onError={(u) => {
            if (u === photo.url) setFailedIndex(safeIndex);
          }}
        />

        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <PhotoOffIcon className="h-9 w-9 text-zinc-600" />
            <p className="text-sm font-medium text-ink-muted">
              This photo couldn&apos;t be loaded.
            </p>
            <p className="text-xs text-zinc-600">
              {safeIndex + 1} of {total} — try another one.
            </p>
          </div>
        )}

        {total > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              className={`${GLASS_NAV_BTN} left-2 md:left-4`}
              aria-label="Previous photo"
            >
              <ChevronIcon dir="left" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              className={`${GLASS_NAV_BTN} right-2 md:right-4`}
              aria-label="Next photo"
            >
              <ChevronIcon dir="right" />
            </button>
          </>
        )}
      </div>

      <footer className="shrink-0 border-t border-white/[0.08] bg-black/80 px-3 py-3 md:px-6 md:py-4">
        <div className="mb-2 hidden items-center justify-between text-2xs font-medium text-zinc-600 md:flex">
          <span>Use ← → to move through the gallery</span>
          <span className="tabular-nums">
            {safeIndex + 1} of {total}
          </span>
        </div>
        <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1 dark-scroll md:gap-2.5">
          {/*
            The strip mounts a WINDOW of thumbnails, not all of them: a
            24-photo gallery used to fire 24 proxy downloads at once, which
            is how the upstream starts throttling and half the strip stays
            blank. The window grows as the strip is scrolled, and the
            selected photo plus its neighbours are always mounted (and eager)
            so navigation lands on an already-decoded frame.
          */}
          {thumbIndices.map((i) => {
            const p = photos[i];
            if (!p) return null;
            const near = Math.abs(i - safeIndex) <= 1;
            return (
              <button
                key={`${p.url}-${i}`}
                type="button"
                onClick={() => jump(i)}
                aria-label={`View photo ${i + 1}`}
                aria-current={i === safeIndex}
                /* ~80×56 px on phones, 112×76 px from md up (was 64×44 — too
                   small to recognise a photo by). The selected frame gets a
                   white ring; the rest stay quiet until hovered. */
                className={`relative h-14 w-20 shrink-0 overflow-hidden rounded-md ring-1 transition md:h-[76px] md:w-28 ${
                  i === safeIndex
                    ? "opacity-100 ring-2 ring-white"
                    : "opacity-40 ring-white/10 hover:opacity-100 hover:ring-white/25"
                }`}
              >
                <SmartImage
                  src={p.thumb}
                  alt=""
                  className="h-full w-full object-cover"
                  loading={near ? "eager" : "lazy"}
                  fetchPriority={near ? "high" : "auto"}
                  sizes="112px"
                  widths={THUMB_WIDTHS}
                  fallback={
                    <span
                      className="absolute inset-0 grid place-items-center bg-zinc-900 text-zinc-700"
                      aria-hidden
                    >
                      <PhotoOffIcon className="h-5 w-5" />
                    </span>
                  }
                />
              </button>
            );
          })}
          {thumbCount < total && (
            <span ref={stripEndRef} className="h-14 w-1 shrink-0 md:h-[76px]" aria-hidden />
          )}
        </div>
      </footer>
    </div>,
    document.body
  );
}
