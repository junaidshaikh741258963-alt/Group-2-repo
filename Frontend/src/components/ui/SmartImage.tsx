/* eslint-disable @next/next/no-img-element */
"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/** Widths the /api/img proxy is allowed to serve. */
const SRCSET_WIDTHS = [320, 640, 960];

/**
 * How long a frame may stay in its loading state before it is treated as
 * failed. Generous enough for a cold proxy download, short enough that a
 * request which never settles cannot leave a card on its skeleton.
 */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * Pause before the single retry. An immediate retry hits the same throttled
 * upstream (429/5xx) and only re-records the failure, so the frame goes
 * straight to its "no photo" fallback even though the photo reappears a
 * second later.
 */
const RETRY_DELAY_MS = 900;

export interface SmartImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
  fetchPriority?: "high" | "low" | "auto";
  /** Lets the browser pick the decode work off the main thread. */
  decoding?: "async" | "sync" | "auto";
  width?: number;
  height?: number;
  onError?: () => void;
  /** First-screen image: eager load + high priority, no lazy savings missed. */
  priority?: boolean;
  /** `sizes` hint for srcset selection. Defaults to a card-ish 33vw after 768px. */
  sizes?: string;
  /**
   * srcset widths to offer (each must be /api/img-allowed). Defaults to the
   * card widths; fullscreen callers pass larger ones so the viewer doesn't
   * upscale a 640 px rendition in a ~80vh frame.
   */
  widths?: number[];
  /** Branded content shown when the image is missing or fails. */
  fallback?: ReactNode;
  /**
   * How long the frame may stay in its loading state before it is treated as
   * failed (the branded fallback takes over). Without this a request that
   * never settles would leave the card on its skeleton forever.
   */
  timeoutMs?: number;
}

/** Only remote http(s) images go through the resize proxy. */
function proxyable(src: string | null | undefined): src is string {
  return Boolean(src && /^https?:\/\//i.test(src) && !src.startsWith("/"));
}

function buildSrcSet(src: string, nonce = 0, widths: number[] = SRCSET_WIDTHS): string {
  // The nonce only rides along on retry requests: /api/img ignores unknown
  // params, but the browser treats the URL as new and re-fetches instead of
  // replaying the cached failure.
  const extra = nonce ? `&r=${nonce}` : "";
  return widths
    .map((w) => `/api/img?url=${encodeURIComponent(src)}&w=${w}${extra} ${w}w`)
    .join(", ");
}

/**
 * Image that paints only once it is decoded, so cards never flash empty or pop
 * mid-scroll. Remote images are served through /api/img (WebP + disk cache) at
 * 320/640/960 widths via srcset; the loading state shimmers instead of
 * showing a dark box, and a branded fallback replaces broken frames.
 */
export default memo(function SmartImage({
  src,
  alt,
  className,
  style,
  loading,
  fetchPriority,
  decoding = "async",
  width,
  height,
  onError,
  priority = false,
  sizes = "(max-width: 768px) 90vw, 33vw",
  widths,
  fallback,
  timeoutMs = LOAD_TIMEOUT_MS,
}: SmartImageProps) {
  const [state, setState] = useState<{
    src: string;
    status: "loading" | "retrying" | "loaded" | "failed";
    /** 0 = first attempt; 1 = one bounded retry after a transient blip. */
    attempt: number;
  }>(() => ({ src: src ?? "", status: "loading", attempt: 0 }));

  // New src in the same slot: reset during render (no stale frame).
  if ((src ?? "") !== state.src) {
    setState({ src: src ?? "", status: "loading", attempt: 0 });
  }

  const reveal = useCallback(() => {
    setState((prev) => ({ ...prev, status: "loaded" }));
  }, []);

  /**
   * A frame that never arrives must not hold its skeleton forever. The
   * timer runs while the image is loading and gives up after `timeoutMs`,
   * handing over to the branded fallback — the same end state as a failed
   * image, so the card is never stuck showing a placeholder.
   */
  const isLoading = state.status === "loading";
  useEffect(() => {
    if (!isLoading || !state.src) return;
    const timer = setTimeout(() => {
      setState((prev) => (prev.status === "loading" ? { ...prev, status: "failed" } : prev));
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [isLoading, state.src, state.attempt, timeoutMs]);

  // The ref callback reveals already-cached images instead of waiting for a
  // load event that already fired.
  const setRef = useCallback(
    (el: HTMLImageElement | null) => {
      if (el && el.complete && el.naturalWidth > 0) reveal();
    },
    [reveal]
  );

  // One delayed retry per src: transient network blips and cold proxy caches
  // heal here without escalating to a server-side re-resolution. The `attempt`
  // counter is the state owner — no timers to leak, and unmounting simply
  // drops the retry.
  const handleError = useCallback(() => {
    setState((prev) => {
      if (prev.status === "failed" || prev.status === "retrying") return prev;
      if (prev.attempt < 1) return { ...prev, status: "retrying" };
      return { ...prev, status: "failed" };
    });
  }, []);

  /** "retrying" is a short pause; the retry itself is the next attempt. */
  const isRetrying = state.status === "retrying";
  useEffect(() => {
    if (!isRetrying) return;
    const timer = setTimeout(() => {
      setState((prev) =>
        prev.status === "retrying"
          ? { ...prev, status: "loading", attempt: prev.attempt + 1 }
          : prev
      );
    }, RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isRetrying]);

  // Report the final failure upward (broken-URL recovery chain) exactly once.
  const reportedRef = useRef(false);
  useEffect(() => {
    if (state.status === "failed" && !reportedRef.current) {
      reportedRef.current = true;
      onError?.();
    }
  }, [state.status, onError, reportedRef]);

  if (!src) return fallback ? <>{fallback}</> : null;
  if (state.status === "failed") return fallback ? <>{fallback}</> : null;
  // Mid-retry: keep the frame empty instead of flashing the fallback, so a
  // recovered photo does not first announce itself as broken.
  if (state.status === "retrying") return null;

  const eager = priority || loading === "eager";

  return (
    <img
      key={`${state.src}#${state.attempt}`}
      ref={setRef}
      src={state.src}
      srcSet={
        proxyable(state.src) && !state.src.startsWith("/api/img")
          ? buildSrcSet(state.src, state.attempt, widths)
          : undefined
      }
      // Retries re-set the bare src too, so non-srcset callers also recover.
      data-retry={state.attempt || undefined}
      sizes={proxyable(state.src) ? sizes : undefined}
      alt={alt}
      width={width}
      height={height}
      className={`smart-img ${state.status === "loading" ? "is-loading" : "is-loaded"}${
        className ? ` ${className}` : ""
      }`}
      style={style}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={fetchPriority ?? (eager ? "high" : "auto")}
      decoding={decoding}
      onLoad={reveal}
      onError={handleError}
    />
  );
});
