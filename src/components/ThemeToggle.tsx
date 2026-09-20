"use client";

import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Light / dark / system for the app chrome.
 *
 * Three states, not two — but light is the one you get on a first visit, even on
 * a machine set to dark. Following the system is a choice you make, not the
 * default: the shelf is meant to look like paper under a lamp until you say
 * otherwise. Light and dark stamp `data-theme` on `<html>` and pin it; "system"
 * is stored as itself and removes the attribute, handing `prefers-color-scheme`
 * back the decision.
 *
 * The reader's own paper theme (light / sepia / dark) is deliberately separate —
 * what you want behind a page of prose is not what you want behind a library.
 */

export type Theme = "system" | "light" | "dark";

/** Shared with the inline script in the layout; both must read the same key. */
export const THEME_KEY = "mountain.theme";

/** No stored choice means light, so nothing launches dark by accident. */
export const DEFAULT_THEME: Theme = "light";

const ORDER: Theme[] = ["light", "dark", "system"];

const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const LABEL: Record<Theme, string> = {
  system: "Theme: following your system",
  light: "Theme: light",
  dark: "Theme: dark",
};

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** --bg for each palette, mirrored from globals.css for the toolbar tint. */
const CHROME: Record<"light" | "dark", string> = {
  light: "#f3f7f3",
  dark: "#0e1511",
};

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  // Keep the browser's toolbar tint on the same palette as the page. Under
  // "system" it is read once here rather than watched: the tint follows on the
  // next load, which is as much as a static meta tag ever did.
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", CHROME[resolved]);
}

export default function ThemeToggle() {
  // The first client render must match the server. The inline layout script
  // has already painted the stored palette, and this layout effect updates the
  // button's label/icon before the browser paints the hydrated tree.
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useLayoutEffect(() => {
    const stored = readStored();
    // localStorage is the external source of truth; this runs after hydration
    // so the initial client markup still matches the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(stored);
    apply(stored);
  }, []);

  const cycle = useCallback(() => {
    setTheme((prev) => {
      const next = ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length];
      try {
        // "system" is stored rather than cleared: an empty key now means
        // "never chose", which is light.
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode: the choice just will not survive a reload */
      }
      apply(next);
      return next;
    });
  }, []);

  return (
    // A one-glyph button is the easiest thing on the page to miss with a thumb,
    // so the padding — not the glyph — is what carries the target.
    <button
      onClick={cycle}
      className="-mr-2 ml-auto px-2 py-2 text-base text-[var(--text-dim)] transition-colors hover:text-[var(--accent)] sm:mr-0 sm:px-1 sm:text-sm"
      title={`${LABEL[theme]} — click to change`}
      aria-label={LABEL[theme]}
    >
      <span suppressHydrationWarning>{ICON[theme]}</span>
    </button>
  );
}
