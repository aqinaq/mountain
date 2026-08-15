"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Library" },
  { href: "/catalog", label: "Browse" },
  { href: "/vocab", label: "Vocabulary" },
  { href: "/stats", label: "Progress" },
];

export default function Nav() {
  const pathname = usePathname();

  // The reader owns the whole viewport; its own header replaces this one.
  if (pathname.startsWith("/read/")) return null;

  return (
    // The header paints under the status bar on an installed phone app, so it
    // pays the inset back itself — otherwise the wordmark sits behind the clock.
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] pt-[env(safe-area-inset-top)] backdrop-blur">
      {/* Six items will not fit across a phone. Rather than shrink them, the
          row breaks in two: the wordmark and the theme keep the top line, and
          the sections drop to a line of their own. `order` does the moving, so
          there is one set of links in the markup and not two. */}
      <nav className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 sm:flex-nowrap sm:px-5 sm:py-4">
        <Link
          href="/"
          className="display flex items-baseline gap-2 text-[19px] tracking-normal sm:mr-2"
        >
          <span aria-hidden className="text-base leading-none text-[var(--accent)]">⛰</span>
          Mountain
        </Link>

        {/* The current section is marked by a rule under the word, the way a
            running head is marked in print — no pill, no filled background. */}
        <div className="no-scrollbar order-3 -mx-4 flex w-full gap-5 overflow-x-auto px-4 pb-2 sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0 sm:pb-0">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`shrink-0 border-b pb-0.5 text-[13px] whitespace-nowrap transition-colors ${
                  active
                    ? "border-[var(--accent)] text-[var(--text)]"
                    : "border-transparent text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <ThemeToggle />
      </nav>
    </header>
  );
}
