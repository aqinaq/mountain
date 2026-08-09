"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker.
 *
 * Only in a production build: in development Next.js serves modules that change
 * on every edit, and a worker caching them turns hot reload into a source of
 * mysterious stale pages.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* offline reading is a bonus, not a requirement */
      });
    };

    // Registering after load keeps the worker off the critical path.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
