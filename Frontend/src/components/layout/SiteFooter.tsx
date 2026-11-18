import Link from "next/link";

function Brand({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`flex items-center gap-3 w-fit ${className}`}>
      <span className="w-8 h-8 bg-accent-strong rounded-lg flex items-center justify-center">
        <svg
          className="w-4.5 h-4.5 text-white"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.2}
            d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
          />
        </svg>
      </span>
      <span className="text-lg font-semibold tracking-tight text-ink">
        Trip<span className="text-blue-400">Craft</span>
      </span>
    </Link>
  );
}

const PLANNING = [
  { href: "/chat", label: "Plan in chat" },
  { href: "/plan", label: "Guided trip form" },
  { href: "/book", label: "Book travel" },
  { href: "/chat?view=explore", label: "Explore places" },
  { href: "/trips", label: "Saved trips" },
];

const IDEAS = [
  { href: "/chat?q=Plan%20a%20trip%20to%20Lisbon", label: "Plan a city break" },
  { href: "/chat?q=Plan%20a%20two-week%20trip%20to%20Japan", label: "Plan a two-week trip" },
  { href: "/chat?q=Surprise%20me%20with%20a%20trip", label: "Surprise me" },
];

function linkCls(dense: boolean) {
  return dense
    ? "text-ink-muted hover:text-zinc-200 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
    : "text-ink-muted hover:text-ink transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60";
}

export default function SiteFooter({ dense = false }: { dense?: boolean }) {
  if (dense) {
    return (
      <footer className="shrink-0 border-t border-white/[0.06] bg-zinc-950">
        <div className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Brand />
          <span className="hidden md:block w-px h-4 bg-white/10" />
          {PLANNING.map((l) => (
            <Link key={l.href} href={l.href} className={linkCls(true)}>
              {l.label}
            </Link>
          ))}
          <span className="hidden lg:block w-px h-4 bg-white/10" />
          {IDEAS.map((l) => (
            <Link key={l.href} href={l.href} className={linkCls(true)}>
              {l.label}
            </Link>
          ))}
          <span className="ml-auto text-zinc-600">© 2026 TripCraft</span>
        </div>
      </footer>
    );
  }

  return (
    <footer className="border-t border-hairline">
      <div className="max-w-[80rem] mx-auto px-6 md:px-8 lg:px-12 py-16">
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <Brand />
            <p className="mt-4 text-md text-ink-faint max-w-sm leading-relaxed">
              Itineraries, stays, restaurants, flights and maps for trips you plan yourself, with
              help when you want it.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-medium text-ink-faint mb-4">Planning</h4>
            <ul className="space-y-2.5 text-md">
              {PLANNING.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={linkCls(false)}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-medium text-ink-faint mb-4">Ideas</h4>
            <ul className="space-y-2.5 text-md">
              {IDEAS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={linkCls(false)}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-4 text-sm text-zinc-600">
          <span>© 2026 TripCraft</span>
          <span>Photos via Unsplash. Maps via OpenStreetMap.</span>
        </div>
      </div>
    </footer>
  );
}
