import fs from "node:fs/promises";
import path from "node:path";
import { FILES_DIR, getDb, plain, plainAll } from "./db";
import { countWords, parseEpub, parseSubtitles, parseText, type ParsedBook } from "./ingest";
import { parsePdf } from "./pdf-layout";
import { coverageByBook, indexBook, indexPending } from "./words";

export type BookRow = {
  id: number;
  title: string;
  author: string;
  language: string;
  cover_url: string | null;
  source: string;
  source_id: string | null;
  file_name: string | null;
  file_ext: string | null;
  word_count: number;
  created_at: number;
};

export type BookSummary = BookRow & {
  chapter_count: number;
  chapter_idx: number;
  scroll_pct: number;
  updated_at: number | null;
  /** Share of the book's words you already know, or null before it is indexed. */
  coverage?: number | null;
};

export function listBooks(userId: number): BookSummary[] {
  // Books imported before word counting existed, or indexed under older
  // lemmatiser rules, catch up here so the shelf can show coverage.
  indexPending(userId);

  const books = plainAll(
    getDb()
      .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
              COALESCE(p.chapter_idx, 0)  AS chapter_idx,
              COALESCE(p.scroll_pct, 0)   AS scroll_pct,
              p.updated_at                AS updated_at
         FROM books b
         LEFT JOIN progress p ON p.book_id = b.id
        WHERE b.user_id = ?
        ORDER BY COALESCE(p.updated_at, b.created_at) DESC`,
      )
      .all(userId) as BookSummary[],
  );

  const coverage = coverageByBook(userId);
  return books.map((b) => ({ ...b, coverage: coverage.get(b.id) ?? null }));
}

/** Null for a book that is not this reader's — callers turn that into a 404,
 *  so a stranger's id is indistinguishable from one that does not exist. */
export function getBook(userId: number, id: number): BookSummary | null {
  const row =
    (getDb()
      .prepare(
        `SELECT b.*,
                (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
                COALESCE(p.chapter_idx, 0) AS chapter_idx,
                COALESCE(p.scroll_pct, 0)  AS scroll_pct,
                p.updated_at               AS updated_at
           FROM books b
           LEFT JOIN progress p ON p.book_id = b.id
          WHERE b.id = ? AND b.user_id = ?`,
      )
      .get(id, userId) as BookSummary | undefined) ?? null;
  return row ? plain(row) : null;
}

export type Section = { index: number; text: string };
export type ChapterRef = { idx: number; title: string; sections: Section[] };

const HEADING_RE = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;

/**
 * The headings inside a chapter, so the contents list can jump into the middle
 * of a long one. `index` is the heading's position among *all* headings in the
 * chapter — the reader re-finds it by querying the rendered DOM in the same
 * order, so blank headings still have to occupy their slot in the count.
 */
function sectionsOf(html: string): Section[] {
  const sections: Section[] = [];
  let index = 0;
  for (const m of html.matchAll(HEADING_RE)) {
    const text = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (text) sections.push({ index, text: text.slice(0, 90) });
    index++;
  }
  return sections;
}

export function getChapters(userId: number, bookId: number): ChapterRef[] {
  const rows = plainAll(
    getDb()
      .prepare(
        `SELECT c.idx, c.title, c.html FROM chapters c
           JOIN books b ON b.id = c.book_id
          WHERE c.book_id = ? AND b.user_id = ?
          ORDER BY c.idx`,
      )
      .all(bookId, userId) as { idx: number; title: string; html: string }[],
  );
  return rows.map(({ idx, title, html }) => ({ idx, title, sections: sectionsOf(html) }));
}

export function getChapter(userId: number, bookId: number, idx: number) {
  const row =
    (getDb()
      .prepare(
        `SELECT c.idx, c.title, c.html FROM chapters c
           JOIN books b ON b.id = c.book_id
          WHERE c.book_id = ? AND c.idx = ? AND b.user_id = ?`,
      )
      .get(bookId, idx, userId) as { idx: number; title: string; html: string } | undefined) ?? null;
  return row ? plain(row) : null;
}

export async function deleteBook(userId: number, id: number) {
  const book = getDb()
    .prepare("SELECT file_name FROM books WHERE id = ? AND user_id = ?")
    .get(id, userId) as { file_name: string | null } | undefined;
  if (!book) return;
  // book_words and book_index cascade; the FTS virtual table has no foreign key.
  getDb().prepare("DELETE FROM chapters_fts WHERE book_id = ?").run(id);
  getDb().prepare("DELETE FROM books WHERE id = ? AND user_id = ?").run(id, userId);
  if (book?.file_name) {
    await fs.rm(path.join(/*turbopackIgnore: true*/ FILES_DIR, book.file_name), { force: true });
  }
}

type SaveInput = {
  userId: number;
  parsed: ParsedBook;
  source: "upload" | "gutenberg" | "web";
  sourceId?: string;
  coverUrl?: string;
  original?: { buffer: Buffer; ext: string };
  titleOverride?: string;
  authorOverride?: string;
};

export async function saveBook(input: SaveInput): Promise<number> {
  const db = getDb();
  const { parsed } = input;
  const title = input.titleOverride?.trim() || parsed.title;
  const author = input.authorOverride?.trim() || parsed.author;

  let fileName: string | null = null;
  if (input.original) {
    fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${input.original.ext}`;
    await fs.writeFile(path.join(/*turbopackIgnore: true*/ FILES_DIR, fileName), input.original.buffer);
  }

  db.exec("BEGIN");
  try {
    const info = db
      .prepare(
        `INSERT INTO books (user_id, title, author, language, cover_url, source, source_id,
                            file_name, file_ext, word_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.userId,
        title,
        author,
        parsed.language || "en",
        input.coverUrl ?? null,
        input.source,
        input.sourceId ?? null,
        fileName,
        input.original?.ext ?? null,
        countWords(parsed.chapters),
        Date.now(),
      );
    const bookId = Number(info.lastInsertRowid);

    const insert = db.prepare(
      "INSERT INTO chapters (book_id, idx, title, html) VALUES (?, ?, ?, ?)",
    );
    parsed.chapters.forEach((c, i) => insert.run(bookId, i, c.title, c.html));

    db.exec("COMMIT");

    // Word counts and the search index. A failure here costs the coverage
    // figures, not the book — `ensureIndexed` will retry on first read.
    try {
      indexBook(bookId);
    } catch {
      /* indexed lazily instead */
    }

    return bookId;
  } catch (err) {
    db.exec("ROLLBACK");
    if (fileName) {
      await fs.rm(path.join(/*turbopackIgnore: true*/ FILES_DIR, fileName), { force: true });
    }
    throw err;
  }
}

export async function ingestBuffer(
  buffer: Buffer,
  fileName: string,
): Promise<{ parsed: ParsedBook; ext: string }> {
  const ext = (path.extname(fileName).slice(1) || "txt").toLowerCase();
  const base = path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, " ").trim();

  if (ext === "epub") return { parsed: await parseEpub(buffer), ext };
  if (ext === "pdf") return { parsed: await parsePdf(buffer, base || "Untitled"), ext };
  if (ext === "srt" || ext === "vtt") {
    return { parsed: parseSubtitles(buffer.toString("utf8"), base || "Subtitles"), ext };
  }
  if (ext === "txt" || ext === "text" || ext === "md") {
    return { parsed: parseText(buffer.toString("utf8"), base || "Untitled"), ext: "txt" };
  }
  throw new Error(
    `Unsupported file type ".${ext}". Upload an EPUB, PDF, TXT, or subtitle (SRT/VTT) file.`,
  );
}

/* ------------------------------ web articles ------------------------------ */

/** Import a web page as a book. Re-importing the same URL returns the original. */
export async function importFromUrl(userId: number, url: string): Promise<number> {
  const { fetchArticle } = await import("./article");

  let normalized: string;
  try {
    normalized = new URL(url.trim()).toString();
  } catch {
    throw new Error("That does not look like a web address.");
  }

  // Scoped to the reader: "already imported" has to mean already in *your*
  // library, or you would be handed a book id you cannot open.
  const existing = getDb()
    .prepare("SELECT id FROM books WHERE user_id = ? AND source = 'web' AND source_id = ?")
    .get(userId, normalized) as { id: number } | undefined;
  if (existing) return existing.id;

  const parsed = await fetchArticle(normalized);
  return saveBook({ userId, parsed, source: "web", sourceId: normalized });
}

/* ---------------------- Project Gutenberg (public domain) ---------------------- */

export type CatalogBook = {
  id: number;
  title: string;
  authors: string;
  languages: string[];
  subjects: string[];
  downloadCount: number;
  coverUrl?: string;
  epubUrl?: string;
  textUrl?: string;
};

type GutendexBook = {
  id: number;
  title: string;
  authors?: { name?: string }[];
  languages?: string[];
  subjects?: string[];
  download_count?: number;
  formats?: Record<string, string>;
};

function mapGutendex(b: GutendexBook): CatalogBook {
  const f = b.formats ?? {};
  const pick = (test: (k: string) => boolean) =>
    Object.entries(f).find(([k, v]) => test(k) && !v.endsWith(".zip"))?.[1];

  return {
    id: b.id,
    title: b.title,
    authors: (b.authors ?? []).map((a) => a.name).filter(Boolean).join(", ") || "Unknown",
    languages: b.languages ?? [],
    subjects: (b.subjects ?? []).slice(0, 4),
    downloadCount: b.download_count ?? 0,
    coverUrl: pick((k) => k.startsWith("image/")),
    epubUrl: pick((k) => k.includes("epub")),
    textUrl: pick((k) => k.startsWith("text/plain")),
  };
}

export async function searchCatalog(query: string, page: number): Promise<{ books: CatalogBook[]; hasMore: boolean }> {
  const url = new URL("https://gutendex.com/books");
  url.searchParams.set("languages", "en");
  url.searchParams.set("page", String(Math.max(1, page)));
  if (query.trim()) url.searchParams.set("search", query.trim());
  else url.searchParams.set("sort", "popular");

  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Gutenberg catalog is unavailable (HTTP ${res.status}).`);
  const data = (await res.json()) as { results?: GutendexBook[]; next?: string | null };

  return {
    books: (data.results ?? []).map(mapGutendex),
    hasMore: Boolean(data.next),
  };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MountainReader/1.0)" },
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

export async function importFromGutenberg(userId: number, gutenbergId: number): Promise<number> {
  const existing = getDb()
    .prepare("SELECT id FROM books WHERE user_id = ? AND source = 'gutenberg' AND source_id = ?")
    .get(userId, String(gutenbergId)) as { id: number } | undefined;
  if (existing) return existing.id;

  const res = await fetch(`https://gutendex.com/books/${gutenbergId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Book ${gutenbergId} was not found in the Gutenberg catalog.`);
  const meta = mapGutendex((await res.json()) as GutendexBook);

  // EPUB keeps the chapter structure; plain text is the fallback.
  let parsed: ParsedBook | null = null;
  let original: { buffer: Buffer; ext: string } | undefined;

  if (meta.epubUrl) {
    try {
      const buf = await download(meta.epubUrl);
      parsed = await parseEpub(buf);
      original = { buffer: buf, ext: "epub" };
    } catch {
      parsed = null;
    }
  }
  if (!parsed && meta.textUrl) {
    const buf = await download(meta.textUrl);
    parsed = parseText(buf.toString("utf8"), meta.title);
    original = { buffer: buf, ext: "txt" };
  }
  if (!parsed) throw new Error("This title has no downloadable EPUB or text edition.");

  return saveBook({
    userId,
    parsed,
    source: "gutenberg",
    sourceId: String(gutenbergId),
    coverUrl: meta.coverUrl,
    original,
    titleOverride: meta.title,
    authorOverride: meta.authors,
  });
}
