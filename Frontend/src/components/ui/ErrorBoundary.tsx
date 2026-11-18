"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short label for the fallback card ("Map", "Chat"). */
  label?: string;
  /** Compact inline fallback for small panels. */
  compact?: boolean;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors in a subtree and shows a recoverable box instead of
 * a blank screen. The map, chat list and explore grid are each wrapped in
 * their own boundary so one failure never takes the page down.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // Client-side breadcrumb; server logs already capture route errors.
    if (typeof window !== "undefined") {
      console.error(`[ui] ${this.props.label ?? "section"} crashed:`, error);
    }
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label ?? "This section";
    return (
      <div
        role="alert"
        className={`mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/80 px-4 text-center ${
          this.props.compact ? "py-4" : "py-8"
        }`}
      >
        <div className="grid h-10 w-10 place-items-center rounded-full bg-amber-400/15 text-amber-300">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
            <path
              d="M12 8v5m0 3h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-ink">{label} hit an unexpected error</p>
          <p className="text-xs text-ink-muted">
            The rest of the page still works. Try again — if it keeps happening, reload.
          </p>
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          Try again
        </button>
      </div>
    );
  }
}
