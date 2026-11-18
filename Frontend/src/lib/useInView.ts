"use client";

import { useEffect, useState } from "react";

/**
 * True once `ref`'s element is close to the viewport (or immediately when the
 * observer is unavailable). Used to hold off network work — like image lookups
 * — until a card is actually about to be seen.
 */
export function useInView(
  ref: { current: HTMLElement | null } | undefined,
  rootMargin = "600px 0px"
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref?.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  return inView;
}
