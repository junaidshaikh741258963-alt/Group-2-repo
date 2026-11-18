"use client";

import { memo } from "react";

interface ToolFallbackCardProps {
  /** Short headline, e.g. "Structured details unavailable". */
  title?: string;
  /** What the user still gets — the assistant's text answer. */
  note: string;
}

/**
 * Graceful fallback when a structured payload can't be trusted (failed
 * validation, truncated stream, unknown version). Instead of a broken card,
 * the answer's text is presented inside a quiet neutral shell.
 */
function ToolFallbackCard({ title = "Showing the summary instead", note }: ToolFallbackCardProps) {
  return (
    <section
      role="note"
      aria-label="Result summary"
      className="animate-card-in mt-2 flex items-start gap-2 rounded-xl border border-white/10 bg-zinc-950/40 px-3 py-3"
    >
      <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-white/8 text-ink-muted">
        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
          <path
            d="M12 8h.01M11 12h1v4h1m-1-13a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink-muted">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">{note}</p>
      </div>
    </section>
  );
}

export default memo(ToolFallbackCard);
