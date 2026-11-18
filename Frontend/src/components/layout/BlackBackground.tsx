export default function BlackBackground({ variant = "fixed" }: { variant?: "fixed" | "absolute" }) {
  return (
    <div
      aria-hidden
      className={variant === "absolute" ? "black-bg black-bg-absolute" : "black-bg"}
    />
  );
}
