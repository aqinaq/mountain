import path from "node:path";
import { getDb, plain, plainAll } from "./db";
import { isGutenbergUrl, type CatalogBook } from "./gutendex";
import { countWords, parseEpub, parseSubtitles, parseText, type ParsedBook } from "./ingest";
import { parsePdf } from "./pdf-layout";
import { safeFetch } from "./safe-fetch";
import { indexBook, indexPending } from "./words";

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
  /** How many words you looked up and kept while reading this book. */
  saved_words: number;
};

export async function listBooks(userId: number): Promise<BookSummary[]> {
  // Books imported before word counting existed, or indexed under older
  // lemmatiser rules, catch up here so the reader knows which words are new.
  await indexPending(userId);

  const db = await getDb();
  return plainAll(
    await db.all<BookSummary>(
      `SELECT b.*,
              (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
              (SELECT COUNT(*) FROM vocab v WHERE v.book_id = b.id)    AS saved_words,
              COALESCE(p.chapter_idx, 0)  AS chapter_idx,
              COALESCE(p.scroll_pct, 0)   AS scroll_pct,
              p.updated_at                AS updated_at
         FROM books b
         LEFT JOIN progress p ON p.book_id = b.id
        WHERE b.user_id = ?
        ORDER BY COALESCE(p.updated_at, b.created_at) DESC`,
      userId,
    ),
  );
}

/** Null for a book that is not this reader's — callers turn that into a 404,
 *  so a stranger's id is indistinguishable from one that does not exist. */
export async function getBook(userId: number, id: number): Promise<BookSummary | null> {
  const db = await getDb();
  const row =
    (await db.get<BookSummary>(
      `SELECT b.*,
                (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
                (SELECT COUNT(*) FROM vocab v WHERE v.book_id = b.id)    AS saved_words,
                COALESCE(p.chapter_idx, 0) AS chapter_idx,
                COALESCE(p.scroll_pct, 0)  AS scroll_pct,
                p.updated_at               AS updated_at
           FROM books b
           LEFT JOIN progress p ON p.book_id = b.id
          WHERE b.id = ? AND b.user_id = ?`,
      id,
      userId,
    )) ?? null;
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

export async function getChapters(userId: number, bookId: number): Promise<ChapterRef[]> {
  const db = await getDb();
  const rows = plainAll(
    await db.all<{ idx: number; title: string; html: string }>(
      `SELECT c.idx, c.title, c.html FROM chapters c
         JOIN books b ON b.id = c.book_id
        WHERE c.book_id = ? AND b.user_id = ?
        ORDER BY c.idx`,
      bookId,
      userId,
    ),
  );
  return rows.map(({ idx, title, html }) => ({ idx, title, sections: sectionsOf(html) }));
}

export async function getChapter(userId: number, bookId: number, idx: number) {
  const db = await getDb();
  const row =
    (await db.get<{ idx: number; title: string; html: string }>(
      `SELECT c.idx, c.title, c.html FROM chapters c
         JOIN books b ON b.id = c.book_id
        WHERE c.book_id = ? AND c.idx = ? AND b.user_id = ?`,
      bookId,
      idx,
      userId,
    )) ?? null;
  return row ? plain(row) : null;
}

export async function deleteBook(userId: number, id: number) {
  const db = await getDb();
  const book = await db.get<{ id: number }>(
    "SELECT id FROM books WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
  if (!book) return;

  // book_files, book_words and book_index all cascade off the book; the FTS
  // virtual table has no foreign key to cascade through, so it is swept by
  // hand — in the same batch, so a half-deleted book cannot be left behind.
  await db.batch([
    { sql: "DELETE FROM chapters_fts WHERE book_id = ?", args: [id] },
    { sql: "DELETE FROM books WHERE id = ? AND user_id = ?", args: [id, userId] },
  ]);
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
  const db = await getDb();
  const { parsed } = input;
  const title = input.titleOverride?.trim() || parsed.title;
  const author = input.authorOverride?.trim() || parsed.author;

  // The name is kept for the download filename only; the bytes themselves go
  // into book_files, because there is no disk to put them on any more.
  const fileName = input.original
    ? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${input.original.ext}`
    : null;

  const info = await db.run(
    `INSERT INTO books (user_id, title, author, language, cover_url, source, source_id,
                        file_name, file_ext, word_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const bookId = info.lastInsertRowid;

  try {
    const writes: { sql: string; args?: unknown[] }[] = parsed.chapters.map((c, i) => ({
      sql: "INSERT INTO chapters (book_id, idx, title, html) VALUES (?, ?, ?, ?)",
      args: [bookId, i, c.title, c.html],
    }));

    if (input.original) {
      writes.push({
        sql: "INSERT INTO book_files (book_id, ext, bytes) VALUES (?, ?, ?)",
        args: [bookId, input.original.ext, input.original.buffer],
      });
    }

    await db.batch(writes);
  } catch (err) {
    // The book row is already in; a book with no chapters is worse than no
    // book, so it goes back out again.
    await db.run("DELETE FROM books WHERE id = ?", bookId);
    throw err;
  }

  // Word counts and the search index. A failure here costs the coverage
  // figures, not the book — `ensureIndexed` will retry on first read.
  try {
    await indexBook(bookId);
  } catch {
    /* indexed lazily instead */
  }

  return bookId;
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
  const db = await getDb();
  const existing = await db.get<{ id: number }>(
    "SELECT id FROM books WHERE user_id = ? AND source = 'web' AND source_id = ?",
    userId,
    normalized,
  );
  if (existing) return existing.id;

  const parsed = await fetchArticle(normalized);
  return saveBook({ userId, parsed, source: "web", sourceId: normalized });
}

/* ---------------------- Project Gutenberg (public domain) ---------------------- */

/**
 * A book is bigger than an article but not unbounded; the cap is here so a
 * mirror serving something unexpected cannot be read into memory whole.
 */
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/**
 * Gutenberg download addresses are checked against its own hostnames before we
 * get here, but they redirect out to mirrors — so where the bytes finally come
 * from is not something the host check settles, and `safeFetch` re-checks each
 * hop against the private ranges the way it does for any other address.
 */
async function download(url: string): Promise<Buffer> {
  const res = await safeFetch(url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 60_000 });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Download failed (HTTP ${res.status}).`);
  }
  return res.body;
}

/**
 * Fetch and ingest a catalogue book.
 *
 * The description arrives from the browser, which is what did the catalogue
 * lookup — the server cannot, being answered with 403. Only the download
 * addresses matter for safety and they are checked against Gutenberg before
 * anything is fetched; the title and cover are the reader's own to be wrong
 * about, exactly as they are for an upload.
 */
export async function importFromGutenberg(userId: number, meta: CatalogBook): Promise<number> {
  const gutenbergId = meta.id;
  const db = await getDb();
  const existing = await db.get<{ id: number }>(
    "SELECT id FROM books WHERE user_id = ? AND source = 'gutenberg' AND source_id = ?",
    userId,
    String(gutenbergId),
  );
  if (existing) return existing.id;

  // EPUB keeps the chapter structure; plain text is the fallback.
  let parsed: ParsedBook | null = null;
  let original: { buffer: Buffer; ext: string } | undefined;

  if (isGutenbergUrl(meta.epubUrl)) {
    try {
      const buf = await download(meta.epubUrl);
      parsed = await parseEpub(buf);
      original = { buffer: buf, ext: "epub" };
    } catch {
      parsed = null;
    }
  }
  if (!parsed && isGutenbergUrl(meta.textUrl)) {
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
