const STARS = "\u2605\u2605\u2605\u2605\u2605";

import { memo } from "react";

interface StarRatingProps {
  value: number;
  className?: string;
  baseClassName?: string;
  fillClassName?: string;
}

/** Five stars with a clipped overlay so partial ratings render visually. */
export default memo(function StarRating({
  value,
  className = "",
  baseClassName = "text-zinc-600",
  fillClassName = "text-warn",
}: StarRatingProps) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span
      className={`relative inline-block whitespace-nowrap leading-none ${baseClassName} ${className}`}
      role="img"
      aria-label={`${value.toFixed(1)} out of 5 stars`}
    >
      <span aria-hidden="true">{STARS}</span>
      <span
        className={`absolute inset-y-0 left-0 overflow-hidden ${fillClassName}`}
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      >
        {STARS}
      </span>
    </span>
  );
});
