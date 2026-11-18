"use client";

/**
 * Minimal toast store — no context, no dependency.
 *
 * `toast.success("Saved")` from anywhere (including plain lib functions that
 * are not React components). The <Toaster> component subscribes with
 * useSyncExternalStore and renders the stack. Auto-dismiss lives here so the
 * store stays the single source of truth.
 */

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional single action (e.g. "Undo"). */
  action?: { label: string; run: () => void };
}

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  success: 3200,
  info: 4200,
  error: 6000,
};

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

function dismiss(id: number): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const next = toasts.filter((x) => x.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

function push(kind: ToastKind, message: string, action?: ToastItem["action"]): number {
  const id = nextId++;
  const item: ToastItem = { id, kind, message: message.slice(0, 220), action };
  toasts = [...toasts.slice(-(MAX_TOASTS - 1)), item];
  timers.set(
    id,
    setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind])
  );
  emit();
  return id;
}

export const toast = {
  success: (message: string, action?: ToastItem["action"]) => push("success", message, action),
  error: (message: string, action?: ToastItem["action"]) => push("error", message, action),
  info: (message: string, action?: ToastItem["action"]) => push("info", message, action),
  dismiss,
};

/* ————— useSyncExternalStore contract ————— */

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToastsSnapshot(): ToastItem[] {
  return toasts;
}

/**
 * Server/hydration snapshot — must be the same reference every call, or
 * React treats each render as a store change (infinite-loop warning).
 */
const EMPTY_TOASTS: readonly ToastItem[] = [];

export function getToastsServerSnapshot(): readonly ToastItem[] {
  return EMPTY_TOASTS;
}
