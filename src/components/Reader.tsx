"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSummary, ChapterRef } from "@/lib/books";
import type { TranslateResult } from "@/lib/translate";
import type { SearchHit } from "@/lib/words";
import { LANGUAGES } from "@/lib/format";
import { lemma } from "@/lib/lemma";
import { sentenceForElement } from "@/lib/text-dom";
import { wrapWords } from "@/lib/text-dom";
import TranslationCard, { type Anchor } from "./TranslationCard";
import { useReadAlong } from "./useReadAlong";

type Settings = {
  fontSize: number;
  lineHeight: number;
  width: number;
  surface: "light" | "sepia" | "dark";
  serif: boolean;
  target: string;
  /** Fade words you have marked as known, so the new ones stand out. */
  dimKnown: boolean;
};

const DEFAULTS: Settings = {
  fontSize: 19,
  lineHeight: 1.7,
  width: 660,
  surface: "sepia",
  serif: true,
  target: "kk",
  dimKnown: true,
};

const SETTINGS_KEY = "mountain.settings.v1";

/** How often the reader reports time spent, for the statistics page. */
const HEARTBEAT_MS = 15_000;

export default function Reader({
  book,
  chapters,
}: {
  book: BookSummary;
  chapters: ChapterRef[];
}) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  // Which chapter's section list is unfolded in the contents drawer.
  const [openChapter, setOpenChapter] = useState<number | null>(null);

  const [idx, setIdx] = useState(Math.min(book.chapter_idx, Math.max(0, chapters.length - 1)));
  const [html, setHtml] = useState<string | null>(null);
  const [chapterTitle, setChapterTitle] = useState("");
  const [loadingChapter, setLoadingChapter] = useState(true);

  const [term, setTerm] = useState("");
  const [context, setContext] = useState("");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [popupLoading, setPopupLoading] = useState(false);
  const [popupError, setPopupError] = useState("");
  const [savedTerms, setSavedTerms] = useState<Set<string>>(new Set());
  const [knownLemmas, setKnownLemmas] = useState<Set<string>>(new Set());

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; list: SearchHit[] } | null>(null);
  const [searching, setSearching] = useState(false);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeSpan = useRef<HTMLElement | null>(null);
  const translateReq = useRef(0);
  const restoreTo = useRef<number | null>(book.scroll_pct || null);
  // A section to land on once the chapter it lives in has finished loading.
  const pendingSection = useRef<number | null>(null);
  // A search term to jump to once its chapter has finished loading.
  const pendingFind = useRef<string | null>(null);

  const readAlong = useReadAlong(contentRef, scrollerRef, idx);

  /* ---------------- settings persistence ---------------- */

  // localStorage can only be read after hydration — reading it in a state
  // initializer would make the server and client markup disagree.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
    } catch {
      /* fall back to defaults */
    }
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* private mode, ignore */
      }
      return next;
    });
  }, []);

  /* ---------------- saved vocabulary ---------------- */

  const loadSaved = useCallback(async () => {
    const res = await fetch(`/api/vocab?bookId=${book.id}`);
    const data = await res.json();
    setSavedTerms(
      new Set(((data.items ?? []) as { term: string }[]).map((v) => v.term.toLowerCase())),
    );
  }, [book.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSaved();
  }, [loadSaved]);

  /* ---------------- known words ---------------- */

  // Fetched once and held client-side: deciding whether a word is known has to
  // happen for every word on the page, which is no place for a round trip.
  const loadKnown = useCallback(async () => {
    try {
      const res = await fetch("/api/known?list=1");
      const data = await res.json();
      setKnownLemmas(new Set((data.lemmas ?? []) as string[]));
    } catch {
      /* dimming is cosmetic; carry on without it */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadKnown();
  }, [loadKnown]);

  const markKnown = useCallback(async (word: string) => {
    const base = lemma(word);
    setKnownLemmas((prev) => new Set(prev).add(base));
    await fetch("/api/known", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lemmas: [base] }),
    }).catch(() => {});
  }, []);

  /* ---------------- chapter loading ---------------- */

  // Chapter changes are a genuine external fetch: show the placeholder and
  // drop any open popup before the request goes out.
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingChapter(true);
    setAnchor(null);

    fetch(`/api/books/${book.id}/chapters/${idx}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setHtml(data.chapter?.html ?? "<p>This chapter could not be loaded.</p>");
        setChapterTitle(data.chapter?.title ?? "");
      })
      .finally(() => {
        if (!cancelled) setLoadingChapter(false);
      });

    return () => {
      cancelled = true;
    };
  }, [book.id, idx]);

  /**
   * Scroll to the nth heading of the chapter on screen. The contents list knows
   * headings by their position in the chapter, so this just counts them off in
   * the rendered DOM — no ids to keep in sync with the stored HTML.
   */
  const scrollToHeading = useCallback((n: number) => {
    const root = contentRef.current;
    const scroller = scrollerRef.current;
    if (!root || !scroller) return;

    const heading = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")[n];
    if (!heading) return;

    const top =
      heading.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - 24) });
  }, []);

  /**
   * Find the first occurrence of a search term in the rendered chapter, scroll
   * to it and flash it. The index knows which chapter a hit is in, not where —
   * the word spans are already in the DOM, so re-finding it here is cheaper
   * than storing offsets that would have to stay in step with the stored HTML.
   */
  const scrollToWord = useCallback((needle: string) => {
    const root = contentRef.current;
    const scroller = scrollerRef.current;
    if (!root || !scroller) return;

    const first = needle.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0];
    if (!first) return;

    const match = Array.from(root.querySelectorAll<HTMLElement>(".w")).find((el) =>
      (el.textContent ?? "").toLowerCase().startsWith(first),
    );
    if (!match) return;

    const top =
      match.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3) });

    match.dataset.found = "1";
    window.setTimeout(() => delete match.dataset.found, 2200);
  }, []);

  // Make each word tappable once the chapter HTML is in the DOM, then land on
  // whichever position we were headed for.
  useEffect(() => {
    if (html === null || !contentRef.current) return;
    wrapWords(contentRef.current);

    const scroller = scrollerRef.current;
    if (!scroller) return;

    if (pendingFind.current !== null) {
      const needle = pendingFind.current;
      pendingFind.current = null;
      requestAnimationFrame(() => scrollToWord(needle));
    } else if (pendingSection.current !== null) {
      const n = pendingSection.current;
      pendingSection.current = null;
      requestAnimationFrame(() => scrollToHeading(n));
    } else if (restoreTo.current !== null) {
      const pct = restoreTo.current;
      restoreTo.current = null;
      requestAnimationFrame(() => {
        scroller.scrollTop = pct * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      });
    } else {
      scroller.scrollTop = 0;
    }
  }, [html, scrollToHeading, scrollToWord]);

  // Underline saved words, fade the ones already known. Both are per-word marks
  // on the same pass, and the lemma cache keeps a long chapter to one lookup per
  // distinct surface form rather than one per word on the page.
  useEffect(() => {
    const root = contentRef.current;
    if (!root || html === null) return;

    const cache = new Map<string, string>();
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(".w"))) {
      const word = (el.textContent ?? "").toLowerCase();

      if (savedTerms.has(word)) el.dataset.saved = "1";
      else delete el.dataset.saved;

      let base = cache.get(word);
      if (base === undefined) {
        base = lemma(word);
        cache.set(word, base);
      }
      if (settings.dimKnown && knownLemmas.has(base)) el.dataset.known = "1";
      else delete el.dataset.known;
    }
  }, [savedTerms, knownLemmas, settings.dimKnown, html]);

  /* ---------------- progress ---------------- */

  const saveProgress = useCallback(
    (chapterIdx: number, pct: number, seconds = 0) => {
      void fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: book.id, chapterIdx, scrollPct: pct, seconds }),
        keepalive: true,
      }).catch(() => {});
    },
    [book.id],
  );

  /**
   * Report time spent so the statistics page can count minutes read. Only while
   * the tab is visible — a book left open in a background tab is not reading.
   */
  useEffect(() => {
    let last = Date.now();

    const tick = () => {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      if (document.visibilityState !== "visible") return;
      // A machine woken from sleep would otherwise bank the whole nap.
      if (elapsed > 0 && elapsed < (HEARTBEAT_MS / 1000) * 3) {
        void fetch("/api/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No position in this payload: a heartbeat records time, and must not
          // move the bookmark the scroll handler is keeping up to date.
          body: JSON.stringify({ bookId: book.id, seconds: elapsed }),
          keepalive: true,
        }).catch(() => {});
      }
    };

    const timer = setInterval(tick, HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") last = Date.now();
      else tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      tick();
    };
  }, [book.id]);

  const [scrollPct, setScrollPct] = useState(0);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      const pct = Math.min(1, scroller.scrollTop / max);
      setScrollPct(pct);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveProgress(idx, pct), 600);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [idx, saveProgress]);

  const goTo = useCallback(
    (next: number) => {
      setTocOpen(false);
      const clamped = Math.min(Math.max(0, next), chapters.length - 1);
      if (clamped === idx) return;
      setIdx(clamped);
      saveProgress(clamped, 0);
      setScrollPct(0);
    },
    [chapters.length, idx, saveProgress],
  );

  /** Jump to a section, loading its chapter first when it isn't the open one. */
  const goToSection = useCallback(
    (chapterIdx: number, section: number) => {
      setTocOpen(false);
      if (chapterIdx === idx) {
        scrollToHeading(section);
        return;
      }
      pendingSection.current = section;
      restoreTo.current = null;
      setIdx(chapterIdx);
      saveProgress(chapterIdx, 0);
      setScrollPct(0);
    },
    [idx, saveProgress, scrollToHeading],
  );

  /* ---------------- search ---------------- */

  // Debounced so a typed query costs one request, not one per keystroke. The
  // query is stored with its results so a stale set is never shown against a
  // query it does not belong to.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/books/${book.id}/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!cancelled) setHits({ q, list: (data.hits ?? []) as SearchHit[] });
      } catch {
        if (!cancelled) setHits({ q, list: [] });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [book.id, query]);

  const results = hits && hits.q === query.trim() ? hits.list : null;

  const openHit = useCallback(
    (hit: SearchHit) => {
      setSearchOpen(false);
      const needle = query.trim();
      if (hit.idx === idx) {
        scrollToWord(needle);
        return;
      }
      pendingFind.current = needle;
      restoreTo.current = null;
      pendingSection.current = null;
      setIdx(hit.idx);
      saveProgress(hit.idx, 0);
      setScrollPct(0);
    },
    [idx, query, saveProgress, scrollToWord],
  );

  /* ---------------- translation ---------------- */

  const clearActive = useCallback(() => {
    if (activeSpan.current) delete activeSpan.current.dataset.active;
    activeSpan.current = null;
  }, []);

  const closePopup = useCallback(() => {
    setAnchor(null);
    clearActive();
  }, [clearActive]);

  const runTranslate = useCallback(
    async (text: string, sentence: string, rect: DOMRect) => {
      const id = ++translateReq.current;
      setTerm(text);
      setContext(sentence);
      setResult(null);
      setPopupError("");
      setPopupLoading(true);
      setAnchor({
        x: rect.left + rect.width / 2,
        y: rect.top,
        top: rect.top,
        bottom: rect.bottom,
      });

      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, target: settings.target, bookId: book.id }),
        });
        const data = await res.json();
        if (id !== translateReq.current) return; // superseded by a newer tap
        if (!res.ok) throw new Error(data.error ?? "Translation failed.");
        setResult(data as TranslateResult);
      } catch (err) {
        if (id !== translateReq.current) return;
        setPopupError(err instanceof Error ? err.message : "Translation failed.");
      } finally {
        if (id === translateReq.current) setPopupLoading(false);
      }
    },
    [book.id, settings.target],
  );

  // One handler covers both gestures: a highlighted range wins over a word tap.
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const root = contentRef.current;
      if (!root) return;

      // Let the browser finish settling the selection (notably on touch).
      const target = e.target as HTMLElement;
      window.setTimeout(() => {
        const selection = window.getSelection();
        const selected = selection?.toString().trim() ?? "";

        if (selected && selected.length > 1 && selection && selection.rangeCount) {
          clearActive();
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          void runTranslate(selected.replace(/\s+/g, " ").slice(0, 1200), selected, rect);
          return;
        }

        const span = target.closest<HTMLElement>(".w");
        if (!span || !root.contains(span)) return;

        clearActive();
        span.dataset.active = "1";
        activeSpan.current = span;
        void runTranslate(
          span.textContent ?? "",
          sentenceForElement(root, span),
          span.getBoundingClientRect(),
        );
      }, 10);
    },
    [clearActive, runTranslate],
  );

  const translateContext = useCallback(() => {
    const rect = activeSpan.current?.getBoundingClientRect();
    if (!rect || !context) return;
    void runTranslate(context, context, rect);
  }, [context, runTranslate]);

  const save = useCallback(async () => {
    if (!term) return;
    await fetch("/api/vocab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        term,
        translation: result?.translation ?? "",
        context: context && context !== term ? context : "",
        kind: result?.kind ?? "word",
        bookId: book.id,
      }),
    });
    setSavedTerms((prev) => new Set(prev).add(term.toLowerCase()));
  }, [book.id, context, result, term]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Search inside the book, not inside the rendered page.
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setTocOpen(false);
        setSearchOpen(true);
        return;
      }

      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowRight") goTo(idx + 1);
      if (e.key === "ArrowLeft") goTo(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, idx]);

  const overallPct = chapters.length
    ? Math.round(((idx + scrollPct) / chapters.length) * 100)
    : 0;

  return (
    <div
      className="surface flex h-dvh flex-col"
      data-surface={settings.surface}
      onMouseDown={() => {
        if (anchor) closePopup();
      }}
    >
      {/* ---------------- top bar ---------------- */}
      <header className="z-30 flex shrink-0 items-center gap-2 border-b border-[var(--paper-line)] px-3 py-2">
        <Link
          href="/"
          className="rounded-lg px-2 py-1 text-sm text-[var(--paper-dim)] hover:bg-[var(--paper-line)]"
          title="Back to library"
        >
          ←
        </Link>

        <button
          onClick={() => {
            // Opening the contents unfolds the chapter you are actually in.
            setOpenChapter(idx);
            setTocOpen((v) => !v);
          }}
          className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-sm hover:bg-[var(--paper-line)]"
          title="Table of contents"
        >
          <span className="font-medium">{book.title}</span>
          {chapterTitle && (
            <span className="text-[var(--paper-dim)]"> · {chapterTitle}</span>
          )}
        </button>

        <button
          onClick={() => {
            setSearchOpen((v) => !v);
            setTocOpen(false);
          }}
          className={`rounded-lg px-2 py-1 text-sm hover:bg-[var(--paper-line)] ${
            searchOpen ? "bg-[var(--paper-line)]" : "text-[var(--paper-dim)]"
          }`}
          title="Search inside this book"
          aria-label="Search inside this book"
        >
          ⌕
        </button>

        {readAlong.supported && (
          <button
            onClick={readAlong.toggle}
            className={`rounded-lg px-2 py-1 text-sm hover:bg-[var(--paper-line)] ${
              readAlong.playing ? "bg-[var(--paper-line)]" : "text-[var(--paper-dim)]"
            }`}
            title={readAlong.playing ? "Stop reading aloud" : "Read this chapter aloud"}
            aria-label={readAlong.playing ? "Stop reading aloud" : "Read this chapter aloud"}
          >
            {readAlong.playing ? "▪" : "▶"}
          </button>
        )}

        <select
          value={settings.target}
          onChange={(e) => update({ target: e.target.value })}
          className="rounded-lg border border-[var(--paper-line)] bg-transparent px-2 py-1 text-xs"
          title="Translate into"
        >
          {LANGUAGES.map((l) => (
            // No colour of its own: `color-scheme` on :root makes the browser
            // render the native dropdown to match, and a pinned one would be
            // unreadable in whichever theme it was not chosen for.
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>

        <a
          href={`/api/books/${book.id}/download`}
          className="rounded-lg px-2 py-1 text-sm text-[var(--paper-dim)] hover:bg-[var(--paper-line)]"
          title="Download this book"
        >
          ⤓
        </a>

        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="rounded-lg px-2 py-1 text-sm text-[var(--paper-dim)] hover:bg-[var(--paper-line)]"
          title="Reading settings"
        >
          Aa
        </button>
      </header>

      {/* ---------------- settings ---------------- */}
      {settingsOpen && (
        <div className="z-30 shrink-0 border-b border-[var(--paper-line)] px-4 py-3 text-sm">
          <div className="mx-auto grid max-w-2xl gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[var(--paper-dim)]">Text size</span>
              <input
                type="range"
                min={14}
                max={30}
                value={settings.fontSize}
                onChange={(e) => update({ fontSize: Number(e.target.value) })}
                className="flex-1"
              />
            </label>

            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[var(--paper-dim)]">Spacing</span>
              <input
                type="range"
                min={1.3}
                max={2.4}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => update({ lineHeight: Number(e.target.value) })}
                className="flex-1"
              />
            </label>

            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[var(--paper-dim)]">Width</span>
              <input
                type="range"
                min={460}
                max={980}
                step={20}
                value={settings.width}
                onChange={(e) => update({ width: Number(e.target.value) })}
                className="flex-1"
              />
            </label>

            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[var(--paper-dim)]">Theme</span>
              <div className="flex gap-1">
                {(["light", "sepia", "dark"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => update({ surface: s })}
                    className={`rounded-md border px-2 py-1 text-xs capitalize ${
                      settings.surface === s
                        ? "border-current"
                        : "border-[var(--paper-line)] text-[var(--paper-dim)]"
                    }`}
                  >
                    {s}
                  </button>
                ))}
                <button
                  onClick={() => update({ serif: !settings.serif })}
                  className="ml-2 rounded-md border border-[var(--paper-line)] px-2 py-1 text-xs"
                >
                  {settings.serif ? "Serif" : "Sans"}
                </button>
              </div>
            </div>

            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[var(--paper-dim)]">Known words</span>
              <button
                onClick={() => update({ dimKnown: !settings.dimKnown })}
                className="rounded-md border border-[var(--paper-line)] px-2 py-1 text-xs"
                aria-pressed={settings.dimKnown}
              >
                {settings.dimKnown ? "Faded" : "Normal"}
              </button>
              <span className="text-xs text-[var(--paper-dim)]">
                {knownLemmas.size.toLocaleString()} marked known
              </span>
            </label>

            {readAlong.supported && (
              <label className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-[var(--paper-dim)]">Voice speed</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.6}
                  step={0.1}
                  value={readAlong.rate}
                  onChange={(e) => readAlong.setRate(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-[var(--paper-dim)]">
                  {readAlong.rate.toFixed(1)}×
                </span>
              </label>
            )}
          </div>
        </div>
      )}

      {/* ---------------- search ---------------- */}
      {searchOpen && (
        <div className="z-30 shrink-0 border-b border-[var(--paper-line)] px-4 py-3">
          <div className="mx-auto max-w-2xl">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchOpen(false);
                if (e.key === "Enter" && results?.length) openHit(results[0]);
              }}
              placeholder="Search inside this book…"
              className="w-full rounded-lg border border-[var(--paper-line)] bg-transparent px-3 py-2 text-sm outline-none focus:border-current"
            />

            {query.trim().length >= 2 && (
              <p className="mt-2 text-xs text-[var(--paper-dim)]">
                {searching
                  ? "Searching…"
                  : results === null
                    ? ""
                    : results.length === 0
                      ? "No matches."
                      : `${results.length} chapter${results.length === 1 ? "" : "s"} with matches`}
              </p>
            )}

            {results && results.length > 0 && (
              <ul className="scroll-thin mt-2 max-h-[38vh] overflow-y-auto">
                {results.map((hit) => (
                  <li key={hit.idx}>
                    <button
                      onClick={() => openHit(hit)}
                      className="w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--paper-line)]"
                    >
                      <span className="text-[10px] uppercase tracking-wide text-[var(--paper-dim)]">
                        {hit.title || `Chapter ${hit.idx + 1}`}
                      </span>
                      <span
                        className="search-snippet mt-0.5 block text-[13px] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: hit.snippet }}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ---------------- table of contents ---------------- */}
      {tocOpen && (
        <div className="absolute inset-0 z-40 flex" onMouseDown={() => setTocOpen(false)}>
          <div
            className="scroll-thin surface h-full w-[min(340px,85vw)] overflow-y-auto border-r border-[var(--paper-line)] shadow-2xl"
            data-surface={settings.surface}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="sticky top-0 border-b border-[var(--paper-line)] bg-[var(--paper)] px-4 py-3 text-xs uppercase tracking-wide text-[var(--paper-dim)]">
              Contents · {chapters.length}
            </p>
            <ul className="py-1">
              {chapters.map((c) => (
                <li key={c.idx}>
                  <div className="flex items-stretch">
                    <button
                      onClick={() => goTo(c.idx)}
                      className={`min-w-0 flex-1 px-4 py-2 text-left text-sm hover:bg-[var(--paper-line)] ${
                        c.idx === idx ? "font-semibold" : "text-[var(--paper-dim)]"
                      }`}
                    >
                      <span className="mr-2 text-[10px] tabular-nums opacity-60">{c.idx + 1}</span>
                      {c.title}
                    </button>
                    {c.sections.length > 0 && (
                      <button
                        onClick={() =>
                          setOpenChapter((prev) => (prev === c.idx ? null : c.idx))
                        }
                        className="shrink-0 px-3 text-[10px] text-[var(--paper-dim)] hover:bg-[var(--paper-line)]"
                        title={`${c.sections.length} sections`}
                        aria-expanded={openChapter === c.idx}
                      >
                        {openChapter === c.idx ? "▾" : "▸"}
                      </button>
                    )}
                  </div>

                  {openChapter === c.idx && (
                    <ul className="mb-2 ml-6 border-l border-[var(--paper-line)]">
                      {c.sections.map((s) => (
                        <li key={s.index}>
                          <button
                            onClick={() => goToSection(c.idx, s.index)}
                            className="block w-full py-1.5 pr-4 pl-3 text-left text-xs text-[var(--paper-dim)] hover:bg-[var(--paper-line)] hover:text-[var(--paper-ink)]"
                          >
                            {s.text}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex-1 bg-black/30" />
        </div>
      )}

      {/* ---------------- text ---------------- */}
      <div ref={scrollerRef} className="scroll-thin relative flex-1 overflow-y-auto">
        <article
          className="mx-auto px-5 pt-12 pb-16"
          style={{
            maxWidth: settings.width,
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight,
            fontFamily: settings.serif
              ? 'Georgia, "Iowan Old Style", "Times New Roman", serif'
              : "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          {loadingChapter ? (
            <p className="py-20 text-center text-sm text-[var(--paper-dim)]">Loading…</p>
          ) : (
            <>
              {/* Chapter opening: the title gets the drop of air a printed page
                  gives it, so the text below reads as a new chapter. */}
              {chapterTitle && (
                <h1 className="mx-auto mb-10 max-w-[22em] text-center text-[1.35em] leading-snug font-semibold tracking-[0.02em] text-balance">
                  {chapterTitle}
                </h1>
              )}
              <div
                ref={contentRef}
                className="prose-reader"
                onPointerUp={onPointerUp}
                dangerouslySetInnerHTML={{ __html: html ?? "" }}
              />
              <div className="mt-14 flex items-center justify-between gap-3 border-t border-[var(--paper-line)] pt-6 text-sm">
                <button
                  className="btn btn-paper"
                  onClick={() => goTo(idx - 1)}
                  disabled={idx === 0}
                >
                  ← Previous
                </button>
                <span className="text-xs text-[var(--paper-dim)]">
                  {idx + 1} / {chapters.length}
                </span>
                <button
                  className="btn btn-paper"
                  onClick={() => goTo(idx + 1)}
                  disabled={idx >= chapters.length - 1}
                >
                  Next →
                </button>
              </div>
            </>
          )}
        </article>
      </div>

      {/* ---------------- progress ---------------- */}
      <div className="h-1 shrink-0 bg-[var(--paper-line)]">
        <div
          className="h-full bg-[color-mix(in_srgb,var(--paper-ink)_45%,transparent)] transition-[width] duration-150"
          style={{ width: `${overallPct}%` }}
        />
      </div>

      <TranslationCard
        term={term}
        context={context}
        result={result}
        loading={popupLoading}
        error={popupError}
        saved={savedTerms.has(term.toLowerCase())}
        known={knownLemmas.has(lemma(term))}
        anchor={anchor}
        onClose={closePopup}
        onSave={() => void save()}
        onMarkKnown={() => void markKnown(term)}
        onTranslateContext={translateContext}
      />
    </div>
  );
}
