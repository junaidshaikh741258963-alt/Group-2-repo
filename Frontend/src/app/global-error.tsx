"use client";

/**
 * Catches errors thrown in the root layout itself — must render its own
 * <html>/<body>, so styling here stays inline-ish and self-contained.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#09090b",
          color: "#f4f4f5",
          fontFamily: "system-ui, sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>
            TripCraft failed to load
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#a1a1aa", margin: "0 0 20px" }}>
            An unexpected error interrupted the app shell. Reloading usually fixes it.
            {error.digest ? ` (code ${error.digest})` : ""}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "#2563eb",
              color: "#fff",
              padding: "10px 18px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
