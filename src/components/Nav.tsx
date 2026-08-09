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
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] backdrop-blur">
      <nav className="mx-auto flex max-w-4xl items-center gap-5 px-5 py-4">
        <Link
          href="/"
          className="display mr-2 flex items-baseline gap-2 text-[19px] tracking-normal"
        >
          <span aria-hidden className="text-base leading-none text-[var(--accent)]">⛰</span>
          Mountain
        </Link>

        {/* The current section is marked by a rule under the word, the way a
            running head is marked in print — no pill, no filled background. */}
        {LINKS.map((l) => {
          const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`border-b pb-0.5 text-[13px] transition-colors ${
                active
                  ? "border-[var(--accent)] text-[var(--text)]"
                  : "border-transparent text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              }`}
            >
              {l.label}
            </Link>
          );
        })}

        <ThemeToggle />
      </nav>
    </header>
  );
}
