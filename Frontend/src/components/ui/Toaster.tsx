"use client";

import { useSyncExternalStore } from "react";
import {
  getToastsServerSnapshot,
  getToastsSnapshot,
  subscribeToasts,
  toast,
  type ToastItem,
} from "@/lib/toast";

const ICONS: Record<ToastItem["kind"], string> = {
  success: "M5 13l4 4L19 7",
  error: "M12 8v5m0 3h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 8h.01M11 12h1v4h1m-1-13a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
};

const TONES: Record<ToastItem["kind"], string> = {
  success: "text-emerald-300 border-emerald-400/25",
  error: "text-rose-300 border-rose-400/30",
  info: "text-zinc-200 border-white/15",
};

/**
 * Bottom-centre toast stack. Above every overlay (gallery lightbox is
 * z-[120]) so confirmations like "Moved to day 2" are never hidden.
 */
export default function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToastsSnapshot, getToastsServerSnapshot);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-[130] flex flex-col items-center gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`animate-card-in pointer-events-auto flex max-w-md items-center gap-2 rounded-xl border bg-zinc-900/95 px-3 py-2 text-sm shadow-2xl shadow-black/60 backdrop-blur-sm ${TONES[t.kind]}`}
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0" aria-hidden>
            <path
              d={ICONS[t.kind]}
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="min-w-0 flex-1 text-ink">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.run();
                toast.dismiss(t.id);
              }}
              className="shrink-0 rounded-lg border border-white/15 px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => toast.dismiss(t.id)}
            className="-mr-1 shrink-0 rounded-lg p-1 text-ink-faint transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
