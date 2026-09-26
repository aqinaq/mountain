"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import type { BookSummary } from "@/lib/books";
import { formatWords, readingTime, relativeTime } from "@/lib/format";
import DeviceLink from "./DeviceLink";

type ImportError = {
  source: "file" | "article" | "library" | "demo";
  title: string;
  message: string;
  hint?: string;
};

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(["epub", "pdf", "txt", "text", "md", "srt", "vtt"]);

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return {};
  return (await res.json()) as Record<string, unknown>;
}

function messageFrom(data: Record<string, unknown>, fallback: string): string {
  return typeof data.error === "string" ? data.error : fallback;
}

export default function Library({ initialBooks }: { initialBooks: BookSummary[] }) {
  const router = useRouter();
  const [books, setBooks] = useState(initialBooks);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<ImportError | null>(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [demoing, setDemoing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/books");
    const data = await responseJson(res);
    if (!res.ok) throw new Error(messageFrom(data, "Your library could not be refreshed."));
    setBooks(Array.isArray(data.books) ? (data.books as BookSummary[]) : []);
  }, []);

  const upload = useCallback(
    async (file: File) => {
      // Allow choosing the same file again after a client-side validation error.
      if (inputRef.current) inputRef.current.value = "";
      const extension = file.name.includes(".") ? file.name.split(".").pop()?.toLowerCase() ?? "" : "";
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        setError({
          source: "file",
          title: "This file type is not supported",
          message: extension ? `“.${extension}” files cannot be imported.` : "This file has no extension.",
          hint: "Choose an EPUB, PDF, TXT, Markdown, SRT, or VTT file.",
        });
        return;
      }
      if (file.size === 0) {
        setError({
          source: "file",
          title: "This file is empty",
          message: "There is no content to import.",
          hint: "Choose a different copy of the document.",
        });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError({
          source: "file",
          title: "This file is too large",
          message: `${(file.size / 1048576).toFixed(1)} MB exceeds the 4 MB upload limit.`,
          hint: "Use a smaller file or split the document before importing it.",
        });
        return;
      }

      setUploading(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: form });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(messageFrom(data, "The file could not be imported."));
        await load();
      } catch (err) {
        setError({
          source: "file",
          title: "The file could not be imported",
          message: err instanceof Error ? err.message : "The upload failed.",
          hint: "Check that the file opens normally, then try again. Scanned PDFs need OCR.",
        });
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
    try {
      const parsed = new URL(address);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      setError({
        source: "article",
        title: "Enter a complete article URL",
        message: "The address must begin with http:// or https://.",
        hint: "Copy the address from your browser’s address bar and try again.",
      });
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/import/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: address }),
      });
      const data = await responseJson(res);
      if (!res.ok) throw new Error(messageFrom(data, "That page could not be imported."));
      setUrl("");
      await load();
    } catch (err) {
      setError({
        source: "article",
        title: "The article could not be imported",
        message: err instanceof Error ? err.message : "The page could not be read.",
        hint: "Try the article’s canonical URL. Paywalls and pages that require JavaScript are not supported.",
      });
    } finally {
      setImporting(false);
    }
  }, [load, url]);

  const openDemo = useCallback(async () => {
    setDemoing(true);
    setError(null);
    try {
      const res = await fetch("/api/demo", { method: "POST" });
      const data = await responseJson(res);
      if (!res.ok) throw new Error(messageFrom(data, "The sample could not be opened."));
      router.push(`/read/${Number(data.id)}`);
    } catch (err) {
      setError({
        source: "demo",
        title: "The sample could not be opened",
        message: err instanceof Error ? err.message : "Please try again.",
      });
      setDemoing(false);
    }
  }, [router]);

  const remove = useCallback(
    async (book: BookSummary) => {
      if (!confirm(`Remove “${book.title}” from your library? This cannot be undone.`)) return;
      setError(null);
      try {
        const res = await fetch(`/api/books/${book.id}`, { method: "DELETE" });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(messageFrom(data, "The book could not be removed."));
        await load();
      } catch (err) {
        setError({
          source: "library",
          title: "The book was not removed",
          message: err instanceof Error ? err.message : "Please try again.",
        });
      }
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
        className={`relative mb-5 flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-3 overflow-hidden rounded-md border border-dashed px-5 py-5 transition-colors focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] ${
          dragging
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]"
            : "border-[var(--border-strong)]"
        }`}
      >
        <input
          id="book-file-input"
          ref={inputRef}
          type="file"
          accept=".epub,.pdf,.txt,.md,.srt,.vtt"
          disabled={uploading}
          aria-label="Choose a book file"
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <span className="text-lg text-[var(--text-dim)]" aria-hidden>
          {uploading ? <span className="spin inline-block">◌</span> : "＋"}
        </span>
        {/* Dropping is a thing you can only do with a mouse. The instruction
            that assumes one is kept, but as the aside it is on a phone. */}
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {uploading ? "Reading your book…" : "Add an EPUB, PDF, TXT, Markdown, or subtitle file"}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            Up to 4 MB. Files are kept in your library, not shared.
            <span className="hidden sm:inline"> Or drag one onto this box.</span>
          </p>
        </div>
        <span className="btn" aria-hidden="true">
          Choose a file
        </span>
      </div>

      {/* Anything readable on the web is fair game too — the article is pulled
          out of the page and stored like any other book. */}
      <form
        className="mb-4 flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void importUrl();
        }}
      >
        <div className="min-w-0 flex-1">
          <label htmlFor="article-url" className="mb-1 block text-xs font-medium text-[var(--text-dim)]">
            Article URL
          </label>
          <input
            id="article-url"
            className="field"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://example.com/article"
            aria-describedby="article-url-help"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={importing}
          />
          <span id="article-url-help" className="sr-only">
            Paste the complete address of a publicly accessible article.
          </span>
        </div>
        <button className="btn" type="submit" disabled={importing || !url.trim()}>
          {importing ? <span className="spin inline-block">◌</span> : "Import"}
        </button>
      </form>

      <details className="mb-10 border-l-2 border-[var(--border)] py-1 pl-3 text-xs leading-relaxed text-[var(--text-dim)]">
        <summary className="cursor-pointer font-medium text-[var(--text)]">Storage, privacy, and retention</summary>
        <div className="mt-2 max-w-2xl space-y-2">
          <p>
            Your original upload, parsed chapters, reading progress, and saved vocabulary are stored in the app’s database and tied to this browser by a private session cookie. Article imports also store the source URL.
          </p>
          <p>
            Files are not public or shared with other readers. When you request an explanation, only the selected word or passage is sent to the translation and dictionary providers—not the whole book.
          </p>
          <p>
            There is no automatic expiry. Removing a book deletes its original file, chapters, search index, and progress; vocabulary you saved from it remains for review until you delete that vocabulary.
          </p>
        </div>
      </details>

      {error && (
        <div
          className="mb-6 rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] px-4 py-3 text-sm"
          role="alert"
          aria-live="assertive"
        >
          <p className="font-medium text-[var(--danger)]">{error.title}</p>
          <p className="mt-1 text-[var(--text)]">{error.message}</p>
          {error.hint && <p className="mt-1 text-xs text-[var(--text-dim)]">{error.hint}</p>}
        </div>
      )}

      {/* shelf */}
      {books.length === 0 ? (
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
