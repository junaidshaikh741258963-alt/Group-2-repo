import Link from "next/link";

export const metadata = {
  title: "Page not found · TripCraft",
};

export default function NotFound() {
  return (
    <main className="grid min-h-96 place-items-center px-4 py-16">
      <div className="max-w-md text-center">
        <p className="text-5xl font-semibold tracking-[-0.03em] text-ink">404</p>
        <h1 className="mt-3 text-xl font-semibold text-ink">This page does not exist</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          The link may be broken, or the page may have moved. Your trips are safe — head back and
          keep planning.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/chat"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Plan in chat
          </Link>
          <Link
            href="/"
            className="rounded-xl border border-white/[0.12] bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-white/[0.2] hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
