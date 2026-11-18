"use client";

import {
  formatVisitDuration,
  formatVisitRange,
  type ResolvedDuration,
} from "@/lib/itinerary/durations";

interface DurationBadgeProps {
  duration: ResolvedDuration;
  className?: string;
}

/**
 * "~2h" chip with a confidence dot and a full tooltip
 * ("Typically 1.5–3h on site — Museum — typical time on site").
 *
 * Dot colours: green = confident (override / strong estimate), amber = a real
 * but soft estimate, faint = category fallback the user should not over-trust.
 */
export default function DurationBadge({ duration, className = "" }: DurationBadgeProps) {
  const dot =
    duration.confidence >= 0.7 ? "bg-ok" : duration.confidence >= 0.45 ? "bg-warn" : "bg-ink-faint";
  const rough = duration.confidence < 0.45;
  const title = `Typically ${formatVisitRange(duration)} on site — ${duration.basis}${
    rough ? " (rough estimate)" : ""
  }`;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border border-hairline bg-surface-2 px-1 py-1 text-2xs font-medium text-ink-muted ${className}`}
      title={title}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="tabular-nums">~{formatVisitDuration(duration)}</span>
    </span>
  );
}
