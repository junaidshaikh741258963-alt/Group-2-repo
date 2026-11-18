import Link from "next/link";

export const metadata = {
  title: "Offline · TripCraft",
  description: "You are offline — your saved trips are still available.",
};

/**
 * Pre-cached by the service worker: the page shown when a navigation happens
 * with no connection and nothing cached for the target route.
 */
export default function OfflinePage() {
  return (
    <main className="grid min-h-96 place-items-center px-4 py-16">
      <div className="max-w-md text-center">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-surface-2 text-2xl"
          aria-hidden
        >
          📡
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-[-0.02em] text-ink">
          You&apos;re offline
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          No connection right now. Trips you have already opened stay available offline —
          everything else will load as soon as you reconnect.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/trips"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Saved trips
          </Link>
          <Link
            href="/itinerary"
            className="rounded-xl border border-white/[0.12] bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-white/[0.2] hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Open your trip
          </Link>
        </div>
      </div>
    </main>
  );
}
