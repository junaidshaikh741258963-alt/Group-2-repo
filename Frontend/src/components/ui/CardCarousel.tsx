"use client";

import { Children, useCallback, useEffect, useRef, useState } from "react";

interface CardCarouselProps {
  /** The cards — direct children of the scroller, so the first one is measured for stepping. */
  children: React.ReactNode;
  /** Names the scroll region for screen readers, e.g. "Attractions". */
  label?: string;
  /** Extra classes for the scroller (callers adjust spacing, not behaviour). */
  className?: string;
}

/** Round overlay arrows — ~36px, #111 at 90%, hairline border, white chevron,
 *  subtle shadow, brighter on hover. Inline SVG rather than lucide-react: the
 *  project doesn't ship an icon set. They stay mounted and fade out at the
 *  edges so the row never reflows. Vertical position defaults to the row
 *  centre and is overridden by the measured image centre when available. */
const ARROW_CLS =
  "absolute top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-white/[0.14] bg-[#111]/90 text-white shadow-md shadow-black/50 transition hover:bg-[#1e1e1e] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 disabled:pointer-events-none disabled:opacity-0";

/** The native scrollbar is hidden but the row keeps every native way to move:
 *  touch swipe, trackpad/drag gestures and keyboard (buttons + focus). */
const SCROLLER_CLS =
  "card-carousel flex gap-3 overflow-x-auto py-1 snap-x snap-proximity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * Horizontal card row with ‹ › arrows instead of a scrollbar. One click steps
 * ~two cards with smooth scrolling; each arrow fades out when there's nothing
 * that way. Edge state comes from a scroll listener plus a ResizeObserver —
 * cards load images that change the scrollable width without resizing the row
 * itself. The arrows anchor to the card images (children tagged
 * `data-card-image`), not the full card, and edge fades mark hidden cards.
 */
export default function CardCarousel({ children, label, className = "" }: CardCarouselProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  /** px offset from the wrapper's top to the first card's image centre; null → fall back to row centre. */
  const [arrowTop, setArrowTop] = useState<number | null>(null);
  const childCount = Children.count(children);

  const arrowRaf = useRef(0);
  // Cancel AND zero the id. A cancelled (stale) id left in the ref would make
  // every later updateArrows() early-return — which is exactly what React's
  // dev effect double-invoke did: it unmounted, cancelled the pending frame,
  // remounted and then could never schedule again, leaving both arrows stuck
  // invisible forever while the row overflowed.
  useEffect(
    () => () => {
      cancelAnimationFrame(arrowRaf.current);
      arrowRaf.current = 0;
    },
    []
  );

  // One measurement per frame, not one per scroll event: `scrollWidth` is a
  // layout metric, and reading it several times inside a single frame (while
  // images may still be landing and dirtying layout) forces a synchronous
  // reflow each time.
  const updateArrows = useCallback(() => {
    if (arrowRaf.current) return;
    arrowRaf.current = requestAnimationFrame(() => {
      arrowRaf.current = 0;
      const el = scroller.current;
      if (!el) return;
      setCanLeft(el.scrollLeft > 4);
      setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);

      // Anchor the arrows to the first card's image (top of the card, 4:3 or
      // fixed height), not the whole card. Offsets are layout-based
      // (offsetTop), so entrance transforms can't skew the anchor.
      const card = el.querySelector<HTMLElement>(":scope > *");
      const img = card?.querySelector<HTMLElement>("[data-card-image]");
      if (img) {
        let y = img.offsetTop + img.offsetHeight / 2;
        for (
          let n = img.offsetParent as HTMLElement | null;
          n && n !== wrapRef.current;
          n = n.offsetParent as HTMLElement | null
        ) {
          y += n.offsetTop;
        }
        setArrowTop(y);
      } else {
        setArrowTop(null);
      }
    });
  }, []);

  useEffect(() => {
    updateArrows();
    const el = scroller.current;
    if (!el) return;
    // Watch the row AND its cards: the scrollable width can grow without the
    // row's own box changing — cards stream in and webfonts swap the cards'
    // min-content widths — and neither a scroll event nor the row's own
    // ResizeObserver fires for those.
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [updateArrows, childCount]);

  // ~Two cards + the gaps between them, measured from the first child (12px
  // matches the row's gap-3); fall back to most of the row for odd content.
  const nudge = useCallback((dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>(":scope > *");
    const step = card ? (card.getBoundingClientRect().width + 12) * 2 : el.clientWidth * 0.8;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  }, []);

  // Soft fades only where more cards await.
  const fadeCls =
    canLeft && canRight ? "cards-fade-both" : canRight ? "cards-fade-r" : canLeft ? "cards-fade-l" : "";
  const anchorStyle = arrowTop !== null ? { top: `${arrowTop}px` } : undefined;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label="Scroll left"
        disabled={!canLeft}
        onClick={() => nudge(-1)}
        style={anchorStyle}
        className={`${ARROW_CLS} left-1`}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div
        ref={scroller}
        onScroll={updateArrows}
        role={label ? "region" : undefined}
        aria-label={label}
        className={`${SCROLLER_CLS} ${fadeCls} ${className}`}
      >
        {children}
      </div>
      <button
        type="button"
        aria-label="Scroll right"
        disabled={!canRight}
        onClick={() => nudge(1)}
        style={anchorStyle}
        className={`${ARROW_CLS} right-1`}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
