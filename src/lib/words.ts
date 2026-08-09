import { getDb, plainAll } from "./db";
import { lemma, tokenize } from "./lemma";
import { CORE_WORDS } from "./core-words";

/**
 * Word knowledge and book coverage.
 *
 * Indexing a book collapses every token onto a lemma and stores the counts, so
 * "how much of this book do I already know?" and "which words should I learn
 * first?" are one query each rather than a re-scan of the text.
 */

/** The chapter HTML is already sanitised to a known tag set, so this is enough. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bump when the lemmatiser changes: stored counts were produced by the old
 * rules, and a book indexed under them would report the wrong coverage forever.
 * Books re-index themselves on next read.
 */
export const INDEX_VERSION = 2;

/** Whether this book is in this reader's library — the check every book-scoped
 *  route makes before it touches anything derived from the text. */
export async function ownsBook(userId: number, bookId: number): Promise<boolean> {
  const db = await getDb();
  return Boolean(
    await db.get("SELECT 1 AS ok FROM books WHERE id = ? AND user_id = ?", bookId, userId),
  );
}

export async function isIndexed(bookId: number): Promise<boolean> {
  const db = await getDb();
  const row = await db.get<{ version: number }>(
    "SELECT version FROM book_index WHERE book_id = ?",
    bookId,
  );
  return row?.version === INDEX_VERSION;
}

/**
 * Count every lemma in a book and fill the search index. Runs once per book;
 * `ensureIndexed` is the entry point everything else uses.
 *
 * The book's own surface forms are handed to the lemmatiser as its lexicon —
 * a text containing "loved" almost certainly contains "love" too, which is what
 * settles the "lov" / "love" ambiguity that suffix rules alone cannot.
 */
export async function indexBook(bookId: number): Promise<{ tokens: number; lemmas: number }> {
  const db = await getDb();
  const chapters = await db.all<{ idx: number; title: string; html: string }>(
    "SELECT idx, title, html FROM chapters WHERE book_id = ? ORDER BY idx",
    bookId,
  );

  const texts = chapters.map((c) => htmlToText(c.html));
  const perChapterTokens = texts.map(tokenize);

  const surface = new Set<string>();
  for (const tokens of perChapterTokens) for (const t of tokens) surface.add(t);

  const counts = new Map<string, number>();
  let total = 0;
  const cache = new Map<string, string>();
  for (const tokens of perChapterTokens) {
    for (const t of tokens) {
      let base = cache.get(t);
      if (base === undefined) {
        base = lemma(t, surface);
        cache.set(t, base);
      }
      counts.set(base, (counts.get(base) ?? 0) + 1);
      total++;
    }
  }

  // One statement per distinct word, which is why this goes out in batches
  // rather than a loop: see `batch` in lib/db.ts. The deletes lead the batch so
  // that a re-index replaces the old rows inside the same transaction.
  const writes: { sql: string; args?: unknown[] }[] = [
    { sql: "DELETE FROM book_words WHERE book_id = ?", args: [bookId] },
    { sql: "DELETE FROM chapters_fts WHERE book_id = ?", args: [bookId] },
  ];

  for (const [base, count] of counts) {
    writes.push({
      sql: "INSERT INTO book_words (book_id, lemma, count) VALUES (?, ?, ?)",
      args: [bookId, base, count],
    });
  }

  chapters.forEach((c, i) => {
    writes.push({
      sql: "INSERT INTO chapters_fts (body, title, book_id, idx) VALUES (?, ?, ?, ?)",
      args: [texts[i], c.title, bookId, c.idx],
    });
  });

  writes.push({
    sql: `INSERT INTO book_index (book_id, indexed_at, tokens, lemmas, version) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(book_id) DO UPDATE SET
            indexed_at = excluded.indexed_at, tokens = excluded.tokens,
            lemmas = excluded.lemmas, version = excluded.version`,
    args: [bookId, Date.now(), total, counts.size, INDEX_VERSION],
  });

  await db.batch(writes);

  return { tokens: total, lemmas: counts.size };
}

export async function ensureIndexed(bookId: number): Promise<void> {
  if (!(await isIndexed(bookId))) await indexBook(bookId);
}

/**
 * Index whatever the library has not caught up with yet, so coverage shows on
 * the shelf rather than only after a book has been opened. Capped per call: it
 * is a one-off cost per book, but a library imported in bulk should not make
 * one page load carry all of it.
 */
export async function indexPending(userId: number, limit = 20): Promise<number> {
  const db = await getDb();
  const stale = await db.all<{ id: number }>(
    `SELECT b.id FROM books b
       LEFT JOIN book_index bi ON bi.book_id = b.id
      WHERE b.user_id = ? AND (bi.book_id IS NULL OR bi.version <> ?)
      ORDER BY b.created_at DESC
      LIMIT ?`,
    userId,
    INDEX_VERSION,
    limit,
  );

  for (const { id } of stale) {
    try {
      await indexBook(id);
    } catch {
      /* a book that will not index must not take the library down with it */
    }
  }
  return stale.length;
}

/* ------------------------------ known words ------------------------------ */

export async function knownCount(userId: number): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM known_words WHERE user_id = ?",
    userId,
  );
  return row?.n ?? 0;
}

export async function isKnown(userId: number, lemmas: string[]): Promise<Set<string>> {
  if (!lemmas.length) return new Set();
  const db = await getDb();
  const placeholders = lemmas.map(() => "?").join(",");
  const rows = await db.all<{ lemma: string }>(
    `SELECT lemma FROM known_words WHERE user_id = ? AND lemma IN (${placeholders})`,
    userId,
    ...lemmas,
  );
  return new Set(rows.map((r) => r.lemma));
}

export async function markKnown(
  userId: number,
  lemmas: string[],
  source: "manual" | "seed" = "manual",
): Promise<number> {
  const db = await getDb();

  // Accepting a seed preset marks thousands of words at once, so this is a
  // batch for the same reason indexing is.
  const clean = [...new Set(lemmas.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return 0;

  const before = await knownCount(userId);
  await db.batch(
    clean.map((l) => ({
      sql: `INSERT INTO known_words (user_id, lemma, source, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, lemma) DO NOTHING`,
      args: [userId, l, source, Date.now()],
    })),
  );

  // A batch reports rows affected per statement rather than in total, and the
  // conflicts are meant to be silent, so the count is taken by difference.
  return (await knownCount(userId)) - before;
}

export async function unmarkKnown(userId: number, lemmaText: string): Promise<void> {
  const db = await getDb();
  await db.run(
    "DELETE FROM known_words WHERE user_id = ? AND lemma = ?",
    userId,
    lemmaText.trim().toLowerCase(),
  );
}

/**
 * Forget the known-word list, or just the part of it that came from the seed
 * presets — a reader who accepted the wrong preset should not have to unpick it
 * one word at a time, nor lose the words they marked by hand.
 */
export async function clearKnown(userId: number, source?: "seed" | "manual"): Promise<number> {
  const db = await getDb();
  const result = source
    ? await db.run("DELETE FROM known_words WHERE user_id = ? AND source = ?", userId, source)
    : await db.run("DELETE FROM known_words WHERE user_id = ?", userId);
  return Number(result.changes);
}

/** Accept the first `count` words of the common-word seed list as known. */
export async function seedCoreWords(userId: number, count: number): Promise<number> {
  const n = Math.max(0, Math.min(count, CORE_WORDS.length));
  return markKnown(userId, CORE_WORDS.slice(0, n), "seed");
}

/** Every known lemma, for the reader to dim as it renders. */
export async function allKnownLemmas(userId: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.all<{ lemma: string }>(
    "SELECT lemma FROM known_words WHERE user_id = ?",
    userId,
  );
  return rows.map((r) => r.lemma);
}

/* -------------------------------- coverage -------------------------------- */

export type Coverage = {
  tokens: number;
  knownTokens: number;
  pct: number;
  distinctLemmas: number;
  unknownLemmas: number;
};

export async function bookCoverage(userId: number, bookId: number): Promise<Coverage> {
  await ensureIndexed(bookId);
  const db = await getDb();

  const idx = await db.get<{ tokens: number; lemmas: number }>(
    "SELECT tokens, lemmas FROM book_index WHERE book_id = ?",
    bookId,
  );
  const tokens = idx?.tokens ?? 0;

  const known =
    (
      await db.get<{ n: number }>(
        `SELECT COALESCE(SUM(bw.count), 0) AS n
           FROM book_words bw
           JOIN known_words k ON k.lemma = bw.lemma AND k.user_id = ?
          WHERE bw.book_id = ?`,
        userId,
        bookId,
      )
    )?.n ?? 0;

  const unknownLemmas =
    (
      await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM book_words bw
           LEFT JOIN known_words k ON k.lemma = bw.lemma AND k.user_id = ?
          WHERE bw.book_id = ? AND k.lemma IS NULL`,
        userId,
        bookId,
      )
    )?.n ?? 0;

  return {
    tokens,
    knownTokens: known,
    pct: tokens ? Math.round((known / tokens) * 1000) / 10 : 0,
    distinctLemmas: idx?.lemmas ?? 0,
    unknownLemmas,
  };
}

/** Coverage for every indexed book at once, for the library shelf. */
export async function coverageByBook(userId: number): Promise<Map<number, number>> {
  const db = await getDb();
  const rows = await db.all<{ book_id: number; tokens: number; known: number }>(
    `SELECT bi.book_id,
              bi.tokens,
              COALESCE((SELECT SUM(bw.count)
                          FROM book_words bw
                          JOIN known_words k ON k.lemma = bw.lemma AND k.user_id = b.user_id
                         WHERE bw.book_id = bi.book_id), 0) AS known
         FROM book_index bi
         JOIN books b ON b.id = bi.book_id
        WHERE b.user_id = ?`,
    userId,
  );

  const out = new Map<number, number>();
  for (const r of rows) {
    out.set(r.book_id, r.tokens ? Math.round((r.known / r.tokens) * 1000) / 10 : 0);
  }
  return out;
}

export type UnknownWord = { lemma: string; count: number; saved: number };

/**
 * The words you do not know yet, commonest first — the study list for a book.
 * `saved` flags the ones already in your vocabulary.
 */
export async function unknownWords(
  userId: number,
  bookId: number,
  limit = 50,
): Promise<UnknownWord[]> {
  await ensureIndexed(bookId);
  const db = await getDb();
  return plainAll(
    await db.all<UnknownWord>(
      `SELECT bw.lemma,
                bw.count,
                EXISTS (SELECT 1 FROM vocab v
                         WHERE v.user_id = ?
                           AND (v.lemma = bw.lemma OR LOWER(v.term) = bw.lemma)) AS saved
           FROM book_words bw
           LEFT JOIN known_words k ON k.lemma = bw.lemma AND k.user_id = ?
          WHERE bw.book_id = ? AND k.lemma IS NULL AND LENGTH(bw.lemma) > 2
          ORDER BY bw.count DESC, bw.lemma
          LIMIT ?`,
      userId,
      userId,
      bookId,
      limit,
    ),
  );
}

/** How often a lemma occurs in one book — shown in the translation card. */
export async function occurrencesInBook(
  userId: number,
  bookId: number,
  word: string,
): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ count: number }>(
    `SELECT bw.count FROM book_words bw
       JOIN books b ON b.id = bw.book_id
      WHERE bw.book_id = ? AND bw.lemma = ? AND b.user_id = ?`,
    bookId,
    lemma(word),
    userId,
  );
  return row?.count ?? 0;
}

/* --------------------------------- search --------------------------------- */

export type SearchHit = { idx: number; title: string; snippet: string };

/** Escape a user query into a safe FTS5 phrase/prefix match. */
function ftsQuery(raw: string): string {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return "";
  return terms.map((t) => `"${t}"`).join(" AND ");
}

/**
 * Snippets are rendered as HTML, and book text can legitimately contain `<`
 * or `&`. FTS5 marks the hit with sentinels no book contains, we escape the
 * whole string, then the sentinels become the only markup that survives.
 */
const OPEN = "";
const CLOSE = "";

function escapeSnippet(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(OPEN)
    .join("<mark>")
    .split(CLOSE)
    .join("</mark>");
}

export async function searchBook(
  userId: number,
  bookId: number,
  query: string,
  limit = 40,
): Promise<SearchHit[]> {
  const match = ftsQuery(query);
  if (!match) return [];
  // chapters_fts is a virtual table with no foreign key to hang ownership on,
  // so the book has to be vouched for before it is searched.
  if (!(await ownsBook(userId, bookId))) return [];
  await ensureIndexed(bookId);

  const db = await getDb();
  const rows = await db.all<SearchHit>(
    `SELECT idx,
            title,
            snippet(chapters_fts, 0, ?, ?, '…', 14) AS snippet
       FROM chapters_fts
      WHERE book_id = ? AND chapters_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    OPEN,
    CLOSE,
    bookId,
    match,
    limit,
  );

  return rows.map((r) => ({ ...r, snippet: escapeSnippet(r.snippet) }));
}
