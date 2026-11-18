import Link from "next/link";

/**
 * Wordmark. One tile, one colour, no two-tone lettering — the mark sits quiet
 * so the accent stays reserved for actions.
 */
export default function Brand({
  href = "/",
  size = "md",
  onClick,
}: {
  href?: string;
  size?: "sm" | "md";
  onClick?: () => void;
}) {
  const tile = size === "sm" ? "h-7 w-7 rounded-lg" : "h-8 w-8 rounded-lg";
  const glyph = size === "sm" ? "h-4 w-4" : "h-4.5 w-4.5";
  const text = size === "sm" ? "text-md" : "text-lg";

  return (
    <Link
      href={href}
      onClick={onClick}
      className="group flex w-fit items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
    >
      <span
        className={`grid ${tile} place-items-center border border-white/[0.12] bg-surface-2 text-blue-300 transition-colors group-hover:border-blue-400/40 group-hover:bg-accent/15 group-hover:text-blue-200`}
      >
        <svg className={glyph} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
          />
        </svg>
      </span>
      <span className={`${text} font-semibold tracking-[-0.02em] text-ink`}>TripCraft</span>
    </Link>
  );
}
