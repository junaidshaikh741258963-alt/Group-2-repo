"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker (`/public/sw.js`) — production only,
 * so dev HMR and Turbopack never fight a stale cache. Failures are silent:
 * offline support is a bonus, never a reason to break the app.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {
          /* no offline support — the app still works */
        });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
