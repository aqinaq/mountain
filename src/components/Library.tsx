"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSummary } from "@/lib/books";
import { formatWords, readingTime, relativeTime } from "@/lib/format";
import DeviceLink from "./DeviceLink";

export default function Library() {
  const router = useRouter();
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [demoing, setDemoing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/books");
    const data = await res.json();
    setBooks(data.books ?? []);
  }, []);

  // Load-on-mount: every setState happens after the await, not during render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError("");
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Upload failed.");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [load],
  );

  const importUrl = useCallback(async () => {
    const address = url.trim();
    if (!address) return;
    setImporting(true);
    setError("");
    try {
      const res = await fetch("/api/import/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "That page could not be imported.");
      setUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That page could not be imported.");
    } finally {
      setImporting(false);
    }
  }, [load, url]);

  const openDemo = useCallback(async () => {
    setDemoing(true);
    setError("");
    try {
      const res = await fetch("/api/demo", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The sample could not be opened.");
      router.push(`/read/${Number(data.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The sample could not be opened.");
      setDemoing(false);
    }
  }, [router]);

  const remove = useCallback(
    async (book: BookSummary) => {
      if (!confirm(`Remove “${book.title}” from your library? This cannot be undone.`)) return;
      await fetch(`/api/books/${book.id}`, { method: "DELETE" });
      await load();
    },
    [load],
  );

  return (
    <main className="page">
      <section className="mb-10">
        <h1 className="display text-[2rem] leading-[1.1] sm:text-[2.5rem]">Your library</h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-dim)]">
          Read in English, tap any word for an instant translation and explanation.
        </p>
      </section>

      {/* upload */}
      <label
        htmlFor="book-file-input"
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading}
        onKeyDown={(e) => {
          if (uploading || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        className={`mb-5 flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-dashed px-5 py-5 transition-colors outline-none focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] ${
          dragging
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]"
            : "border-[var(--border-strong)]"
        }`}
      >
        <span className="text-lg text-[var(--text-dim)]" aria-hidden>
          {uploading ? <span className="spin inline-block">◌</span> : "＋"}
        </span>
        {/* Dropping is a thing you can only do with a mouse. The instruction
            that assumes one is kept, but as the aside it is on a phone. */}
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {uploading ? "Reading your book…" : "Add an EPUB, PDF, TXT, or subtitle file"}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            Up to 4 MB. Files are kept in your library, not shared.
            <span className="hidden sm:inline"> Or drag one onto this box.</span>
          </p>
        </div>
        <span className="btn" aria-hidden="true">
          Choose a file
        </span>
        <input
          id="book-file-input"
          ref={inputRef}
          type="file"
          accept=".epub,.pdf,.txt,.md,.srt,.vtt"
          disabled={uploading}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </label>

      {/* Anything readable on the web is fair game too — the article is pulled
          out of the page and stored like any other book. */}
      <form
        className="mb-10 flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void importUrl();
        }}
      >
        <input
          className="field flex-1"
          type="url"
          placeholder="…or paste a link to an article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={importing}
        />
        <button className="btn" type="submit" disabled={importing || !url.trim()}>
          {importing ? <span className="spin inline-block">◌</span> : "Import"}
        </button>
      </form>

      {error && (
        <p className="mb-6 border-l-2 border-[var(--danger)] py-1 pl-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {/* shelf */}
      {books === null ? (
        <p className="py-12 text-sm text-[var(--text-dim)]">Loading…</p>
      ) : books.length === 0 ? (
        <div className="sheet">
          <p className="eyebrow mb-3">Start reading</p>
          <h2 className="display text-[1.5rem]">Try a short story</h2>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-[var(--text-dim)]">
            Open a two-chapter sample, tap a word, and save it for review. It is added only to your
            own library.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button className="btn" onClick={() => void openDemo()} disabled={demoing}>
              {demoing ? "Opening…" : "Read the sample"}
            </button>
            <Link href="/catalog" className="text-sm text-[var(--accent)] underline underline-offset-4">
              Browse public-domain books
            </Link>
          </div>
        </div>
      ) : (
        <section className="sheet">
          <p className="eyebrow mb-4">
            On the shelf — {books.length} {books.length === 1 ? "book" : "books"}
          </p>
          <ul>
            {books.map((b) => {
              const pct = b.chapter_count
                ? Math.round(((b.chapter_idx + b.scroll_pct) / b.chapter_count) * 100)
                : 0;
              return (
                <li key={b.id} className="row relative">
                  <Link href={`/read/${b.id}`} className="flex gap-4 px-2 py-4 sm:gap-5 sm:py-5">
                    <div className="h-[92px] w-[62px] shrink-0 overflow-hidden rounded-[3px] bg-[var(--bg-hover)] shadow-[0_2px_10px_-4px_rgb(60_44_22/0.4)]">
                      {b.cover_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={b.cover_url}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1.5 text-center font-serif text-[10px] leading-tight text-[var(--text-dim)]">
                          {b.title.slice(0, 40)}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <h2 className="display truncate text-[19px] leading-snug">{b.title}</h2>
                      <p className="mt-0.5 truncate text-[13px] italic text-[var(--text-dim)]">
                        {b.author || "Unknown author"}
                      </p>
                      <p className="mt-2 text-xs text-[var(--text-dim)]">
                        {[
                          `${b.chapter_count} chapters`,
                          formatWords(b.word_count),
                          b.word_count ? `~${readingTime(b.word_count)}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}

                        {/* What you took out of this book: the words you looked
                            up and kept. */}
                        {b.saved_words > 0 && (
                          <>
                            {" · "}
                            <span className="text-[var(--accent)]">
                              {b.saved_words.toLocaleString()} saved
                            </span>
                          </>
                        )}
                      </p>

                      {/* A short gauge next to its own caption, rather than a
                          rule spanning the row — the row already has one. */}
                      <div className="mt-3 flex items-center gap-3">
                        <div className="h-[3px] w-28 shrink-0 rounded-full bg-[var(--bg-hover)]">
                          <div
                            className="h-[3px] rounded-full bg-[var(--accent)]"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-[var(--text-dim)]">
                          {b.updated_at ? `${pct}% · ${relativeTime(b.updated_at)}` : "Not started"}
                        </span>
                      </div>
                    </div>
                  </Link>

                  {/* On a desk these wait in the top corner until the row is
                      pointed at. A phone can neither hover nor spare the corner
                      — the title is already using it — so there they stand in
                      the flow underneath, in plain sight. */}
                  <div className="hover-reveal flex justify-end gap-5 px-2 pb-4 text-xs sm:absolute sm:top-5 sm:right-2 sm:gap-3 sm:pb-0 sm:text-[11px]">
                    <a
                      href={`/api/books/${b.id}/download`}
                      className="py-1 text-[var(--text-dim)] underline underline-offset-4 hover:text-[var(--text)]"
                      title="Download the original file"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => void remove(b)}
                      className="py-1 text-[var(--text-dim)] underline underline-offset-4 hover:text-[var(--danger)]"
                      title="Remove from library"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <DeviceLink />
    </main>
  );
}
