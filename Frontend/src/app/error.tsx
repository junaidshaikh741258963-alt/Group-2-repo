"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Route-level error boundary (App Router `error.tsx`): catches render/data
 * errors below the root layout and offers a retry without a full reload.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[route] crashed:", error);
  }, [error]);

  return (
    <main className="grid min-h-96 place-items-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-amber-400/25 bg-amber-400/10 text-2xl text-amber-300"
          aria-hidden
        >
          ⚠️
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-[-0.02em] text-ink">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          This page hit an unexpected error. Your trips and plans are stored locally and are
          untouched — try again or head back home.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Try again
          </button>
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
