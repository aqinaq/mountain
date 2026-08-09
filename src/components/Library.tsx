"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSummary } from "@/lib/books";
import { formatWords, readingTime, relativeTime } from "@/lib/format";

export default function Library() {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
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

  const remove = useCallback(
    async (book: BookSummary) => {
      if (!confirm(`Remove “${book.title}” from your library? This cannot be undone.`)) return;
      await fetch(`/api/books/${book.id}`, { method: "DELETE" });
      await load();
    },
    [load],
  );

  return (
    <main className="mx-auto max-w-4xl px-5 py-12">
      <section className="mb-10">
        <h1 className="display text-[2.5rem] leading-[1.1]">Your library</h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-dim)]">
          Read in English, tap any word for an instant translation and explanation.
        </p>
      </section>

      {/* upload */}
      <div
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
        className={`mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-dashed px-5 py-5 transition-colors ${
          dragging
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]"
            : "border-[var(--border-strong)]"
        }`}
      >
        <span className="text-lg text-[var(--text-dim)]" aria-hidden>
          {uploading ? <span className="spin inline-block">◌</span> : "＋"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {uploading ? "Reading your book…" : "Drop an EPUB, PDF, TXT, or subtitle file here"}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            Up to 60 MB. Files stay on this machine.
          </p>
        </div>
        <button className="btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
          Choose a file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".epub,.pdf,.txt,.md,.srt,.vtt"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>

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
          <p className="text-sm text-[var(--text-dim)]">
            Nothing here yet. Upload a file above, or{" "}
            <Link href="/catalog" className="text-[var(--accent)] underline underline-offset-4">
              browse free public-domain books
            </Link>
            .
          </p>
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
                <li key={b.id} className="row group relative">
                  <Link href={`/read/${b.id}`} className="flex gap-5 px-2 py-5">
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

                        {/* How readable this book is for you right now. Above ~95%
                            a book reads smoothly; below ~90% it is a slog. */}
                        {b.coverage != null && (
                          <>
                            {" · "}
                            <span
                              className={
                                b.coverage >= 95
                                  ? "text-[var(--good)]"
                                  : b.coverage >= 88
                                    ? "text-[var(--text-dim)]"
                                    : "text-[var(--danger)]"
                              }
                            >
                              {b.coverage}% known
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

                  <div className="absolute right-2 top-5 flex gap-3 text-[11px] opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <a
                      href={`/api/books/${b.id}/download`}
                      className="text-[var(--text-dim)] underline underline-offset-4 hover:text-[var(--text)]"
                      title="Download the original file"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => void remove(b)}
                      className="text-[var(--text-dim)] underline underline-offset-4 hover:text-[var(--danger)]"
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
    </main>
  );
}
