"use client";

import type { SourceRef } from "@/lib/rag/types";

const SOURCE_ICON: Record<SourceRef["source"], string> = {
  memory: "🧠",
  preferences: "⭐",
  knowledge: "📚",
  live: "🛰️",
  web: "🌐",
};

const MAX_CHIPS = 6;

/**
 * Provenance chips under a grounded answer — "Wikivoyage", "OSM nearby", …
 * Each chip carries where the fact lives (`origin`) as its tooltip and links
 * to the source when one is known. Purely additive: an answer with no
 * retrieval renders nothing.
 */
export default function SourceChips({ sources }: { sources: SourceRef[] }) {
  if (!sources.length) return null;
  const chips = sources.slice(0, MAX_CHIPS);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" aria-label="Sources for this answer">
      <span className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Sources</span>
      {chips.map((s) => {
        const inner = (
          <>
            <span aria-hidden>{SOURCE_ICON[s.source] ?? "📎"}</span>
            <span className="max-w-40 truncate">{s.label}</span>
          </>
        );
        const className =
          "inline-flex items-center gap-1 rounded-full border border-white/10 bg-surface-2 px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:border-white/20 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60";
        return s.url ? (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            title={`${s.origin} — open source`}
            className={className}
          >
            {inner}
          </a>
        ) : (
          <span key={s.id} title={s.origin} className={className}>
            {inner}
          </span>
        );
      })}
      {sources.length > chips.length && (
        <span className="text-2xs text-ink-faint">+{sources.length - chips.length} more</span>
      )}
    </div>
  );
}
