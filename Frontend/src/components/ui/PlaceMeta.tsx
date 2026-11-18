"use client";

import { memo } from "react";

/**
 * Shared place-card presentation bits: the star/score/review-count rating and
 * the saved-by heart, used by both card surfaces (chat recommendation cards
 * and the map's place card). One definition means the two surfaces stay
 * visually in step and restyle in a single place.
 */

/**
 * Review counts the way they read on a card: 842 → "842", 13 000 → "13k",
 * 14 300 → "14.3k", 132 000 → "132k".
 */
export function formatReviewCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "";
  if (count < 1000) return String(Math.round(count));
  const thousands = count / 1000;
  const rounded = thousands < 100 ? Math.round(thousands * 10) / 10 : Math.round(thousands);
  return `${rounded}k`;
}

export function StarIcon({ className = "place-star" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31 6.2 20.36l1.11-6.46-4.7-4.58 6.49-.94L12 2.5z" />
    </svg>
  );
}

export function HeartIcon({ className = "place-heart" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21s-7.5-4.7-9.6-9A5.4 5.4 0 0 1 12 6.6a5.4 5.4 0 0 1 9.6 5.4c-2.1 4.3-9.6 9-9.6 9z" />
    </svg>
  );
}

interface PlaceRatingProps {
  rating: number;
  /** Review count — rendered as "(842)" in the default variant. */
  reviews?: number | null;
  /** Compact: glyph + score only, for dense surfaces (chat cards). */
  compact?: boolean;
  /** Surface-specific styling hook (e.g. "map-card-rating"). */
  className?: string;
}

/** ★ + score (+ review count) pill shared by chat cards and the map card. */
export const PlaceRating = memo(function PlaceRating({
  rating,
  reviews,
  compact = false,
  className = "",
}: PlaceRatingProps) {
  if (!Number.isFinite(rating)) return null;
  return (
    <span
      className={`place-rating${compact ? " place-rating-compact" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <StarIcon />
      <span className="place-rating-score">{compact ? String(rating) : rating.toFixed(1)}</span>
      {!compact && reviews != null && reviews > 0 && (
        <span className="place-rating-count">({formatReviewCount(reviews)})</span>
      )}
    </span>
  );
});
