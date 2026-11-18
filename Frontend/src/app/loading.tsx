/**
 * Route-transition fallback — shown while a server segment streams in.
 * Deliberately quiet: a spinner plus a shimmer row, no layout shift.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="h-8 w-8 animate-pulse rounded-lg bg-accent/60" aria-hidden />
        <span className="h-4 w-40 animate-pulse rounded-md bg-white/10" aria-hidden />
      </div>
      <div className="mt-6 flex flex-col gap-3">
        <div className="h-24 animate-pulse rounded-2xl border border-white/10 bg-surface-1" aria-hidden />
        <div className="h-24 animate-pulse rounded-2xl border border-white/10 bg-surface-1" aria-hidden />
        <div className="h-24 animate-pulse rounded-2xl border border-white/10 bg-surface-1" aria-hidden />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
