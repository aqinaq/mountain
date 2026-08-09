"use client";

import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Light / dark / system for the app chrome.
 *
 * Three states, not two: "system" stores nothing and leaves `prefers-color-scheme`
 * in charge, so the app follows the machine as it changes through the day.
 * Choosing light or dark stamps `data-theme` on `<html>` and pins it.
 *
 * The reader's own paper theme (light / sepia / dark) is deliberately separate —
 * what you want behind a page of prose is not what you want behind a library.
 */

export type Theme = "system" | "light" | "dark";

/** Shared with the inline script in the layout; both must read the same key. */
export const THEME_KEY = "mountain.theme";

const ORDER: Theme[] = ["system", "light", "dark"];

const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const LABEL: Record<Theme, string> = {
  system: "Theme: following your system",
  light: "Theme: light",
  dark: "Theme: dark",
};

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function ThemeToggle() {
  // Lazy initialiser rather than an effect, so the button agrees with the
  // attribute the inline script already set. The icon is marked
  // suppressHydrationWarning because the server cannot know the stored value.
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window === "undefined" ? "system" : readStored(),
  );

  // React's dev-only remount resets the attributes on <html>, wiping what the
  // inline script set. Re-applying before paint is a no-op in production.
  useLayoutEffect(() => {
    apply(theme);
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((prev) => {
      const next = ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length];
      try {
        if (next === "system") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode: the choice just will not survive a reload */
      }
      apply(next);
      return next;
    });
  }, []);

  return (
    <button
      onClick={cycle}
      className="ml-auto px-1 text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
      title={`${LABEL[theme]} — click to change`}
      aria-label={LABEL[theme]}
    >
      <span suppressHydrationWarning>{ICON[theme]}</span>
    </button>
  );
}
