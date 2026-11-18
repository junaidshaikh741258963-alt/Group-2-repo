"use client";

import { useEffect, useState } from "react";

/**
 * Keeps an element mounted briefly after its `active` flag flips off so an
 * exit animation can play, instead of unmounting instantly.
 *
 * Returns `[mounted, closing]` — render while `mounted`, and switch the
 * entrance class for an exit class while `closing`.
 */
export function useExitTransition(active: boolean, ms = 180): [boolean, boolean] {
  const [mounted, setMounted] = useState(active);
  const [closing, setClosing] = useState(false);

  // Adjust during render so opening never lags a frame behind the flag.
  if (active && !mounted) setMounted(true);
  if (active && closing) setClosing(false);
  if (!active && mounted && !closing) setClosing(true);

  useEffect(() => {
    if (active || !closing) return;
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, ms);
    return () => clearTimeout(timer);
  }, [active, closing, ms]);

  return [mounted, closing];
}
