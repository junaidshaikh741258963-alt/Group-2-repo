/**
 * Page wash: a flat near-black base, edge to edge — no bloom, no gradient.
 * All the styling lives in `.home-bg` (globals.css) — no moving parts.
 */
export default function HomeBackground({ variant = "fixed" }: { variant?: "fixed" | "absolute" }) {
  return (
    <div aria-hidden className={variant === "absolute" ? "home-bg home-bg-absolute" : "home-bg"} />
  );
}
