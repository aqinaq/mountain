"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { searchCatalog, type CatalogBook } from "@/lib/gutendex";

const SHELVES = ["", "adventure", "detective", "romance", "science fiction", "short stories", "philosophy"];

export default function Catalog() {
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [page, setPage] = useState(1);
  const [books, setBooks] = useState<CatalogBook[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<number | null>(null);
  /** Gutenberg id → local book id, for the titles already on the shelf. */
  const [library, setLibrary] = useState<Record<number, number>>({});
  const reqId = useRef(0);

  // Which catalog entries are already imported, so they offer Read instead of
  // Add across reloads and not just for the ones added in this session.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/books")
      .then((r) => r.json())
      .then((data: { books?: { id: number; source: string; source_id: string | null }[] }) => {
        if (cancelled) return;
        const map: Record<number, number> = {};
        for (const b of data.books ?? []) {
          if (b.source === "gutenberg" && b.source_id) map[Number(b.source_id)] = b.id;
        }
        setLibrary(map);
      })
      .catch(() => {
        /* the shelf state is a nicety; Add still works without it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetching on [query, page] change is exactly what an effect is for: the
  // spinner has to go up before the request, so this setState is intentional.
  useEffect(() => {
    const id = ++reqId.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    // Straight to gutendex from here rather than through our own server: it
    // refuses the deployment's address and accepts the reader's.
    searchCatalog(query, page)
      .then((data) => {
        if (id !== reqId.current) return; // a newer search superseded this one
        setBooks(data.books);
        setHasMore(data.hasMore);
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        setError(err instanceof Error ? err.message : "Search failed.");
        setBooks([]);
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [query, page]);

  const search = useCallback((q: string) => {
    setQuery(q);
    setInput(q);
    setPage(1);
  }, []);

  const add = useCallback(async (book: CatalogBook) => {
    setImporting(book.id);
    setError("");
    try {
      const res = await fetch("/api/catalog/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The whole description, because the server cannot look it up itself.\n        body: JSON.stringify(book),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed.");
      // Stay on the catalog — the card turns into a Read link instead.
      setLibrary((prev) => ({ ...prev, [book.id]: data.id as number }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(null);
    }
  }, []);

  return (
    <main className="page">
      <h1 className="display text-[2rem] leading-[1.1] sm:text-[2.5rem]">Browse free books</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-dim)]">
        Public-domain titles from Project Gutenberg. Add as many as you like — they wait on your
        shelf until you choose to read them.
      </p>

      <form
        className="mt-8 flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          search(input);
        }}
      >
        <input
          className="field min-w-0 flex-1"
          type="search"
          placeholder="Search by title or author…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <div className="mt-4 flex flex-wrap gap-2">
        {SHELVES.map((s) => (
          <button
            key={s || "popular"}
            onClick={() => search(s)}
            aria-pressed={query === s}
            className="chip"
          >
            {s || "Most popular"}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-6 border-l-2 border-[var(--danger)] py-1 pl-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {loading ? (
        <p className="py-16 text-sm text-[var(--text-dim)]">Searching…</p>
      ) : books.length === 0 ? (
        <p className="py-16 text-sm text-[var(--text-dim)]">No books matched that search.</p>
      ) : (
        <ul className="sheet mt-8">
          {books.map((b) => (
            <li key={b.id} className="row flex gap-4 px-2 py-4 sm:gap-5 sm:py-5">
              <div className="h-[92px] w-[62px] shrink-0 overflow-hidden rounded-[3px] bg-[var(--bg-hover)] shadow-[0_2px_10px_-4px_rgb(60_44_22/0.4)]">
                {b.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.coverUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : null}
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                <h2 className="display line-clamp-2 text-[19px] leading-snug">{b.title}</h2>
                <p className="mt-0.5 truncate text-[13px] italic text-[var(--text-dim)]">
                  {b.authors}
                </p>
                <p className="mt-1.5 line-clamp-1 text-[11px] text-[var(--text-dim)]">
                  {b.subjects.join(" · ")}
                </p>

                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
                  {library[b.id] ? (
                    <>
                      <Link className="btn" href={`/read/${library[b.id]}`}>
                        Read
                      </Link>
                      <span className="text-[11px] text-[var(--text-dim)]">In your library</span>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn"
                        onClick={() => void add(b)}
                        disabled={importing !== null}
                      >
                        {importing === b.id ? (
                          <>
                            <span className="spin inline-block">◌</span> Adding…
                          </>
                        ) : (
                          "Add to library"
                        )}
                      </button>
                      <span className="text-[11px] text-[var(--text-dim)]">
                        {b.downloadCount.toLocaleString()} downloads
                      </span>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10 flex items-center justify-center gap-4">
        <button className="btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
          ← Previous
        </button>
        <span className="text-sm text-[var(--text-dim)]">Page {page}</span>
        <button className="btn" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          Next →
        </button>
      </div>
    </main>
  );
}
