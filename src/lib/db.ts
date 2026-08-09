import { createClient, type Client, type InArgs, type Row } from "@libsql/client";
import { randomBytes } from "node:crypto";

/**
 * The database, which is SQLite either way.
 *
 * Locally that is a file; deployed it is Turso, which speaks the same dialect
 * over the network. One connection string decides which, so the schema, the
 * queries and the full-text index are identical in both places and there is no
 * second dialect to keep honest.
 *
 * The one thing the network costs us is synchrony: `node:sqlite` answered
 * immediately and this cannot, so every query here is a promise and every
 * caller waits. That is the whole shape of the change from the version that
 * ran on one machine.
 */

/** A local file unless told otherwise, which is what `next dev` wants. */
const url = process.env.TURSO_DATABASE_URL ?? "file:./data/reader.db";
const authToken = process.env.TURSO_AUTH_TOKEN;

let client: Client | undefined;

function connection(): Client {
  if (!client) {
    client = createClient({
      url,
      authToken,
      // Match node:sqlite, which handed back plain numbers. Ids and millisecond
      // timestamps are both well inside what a double holds exactly.
      intMode: "number",
    });
  }
  return client;
}

/** libSQL rows carry their columns by index as well as by name; take the names. */
function rowToObject<T>(row: Row, columns: string[]): T {
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column] = row[column as keyof Row];
  return out as T;
}

const api = {
  async all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    const result = await connection().execute({ sql, args: args as InArgs });
    return result.rows.map((row) => rowToObject<T>(row, result.columns));
  },

  async get<T>(sql: string, ...args: unknown[]): Promise<T | undefined> {
    const rows = await api.all<T>(sql, ...args);
    return rows[0];
  },

  async run(sql: string, ...args: unknown[]) {
    const result = await connection().execute({ sql, args: args as InArgs });
    return {
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      changes: result.rowsAffected,
    };
  },

  /**
   * Many writes in one round trip, as a single transaction.
   *
   * The difference between this and a loop of `run` is the difference between
   * an app that works and one that does not: indexing a book writes a row per
   * distinct word, which is tens of thousands of statements for a real
   * library. Against a file that was free; against a database on the other end
   * of a network it is tens of thousands of round trips.
   *
   * Chunked, because a batch is held in memory at both ends before it commits.
   * Each chunk is its own transaction — callers that need all-or-nothing across
   * chunks must clear the old rows in the same chunk that writes the new ones.
   */
  async batch(statements: { sql: string; args?: unknown[] }[], chunkSize = 500): Promise<void> {
    for (let i = 0; i < statements.length; i += chunkSize) {
      const chunk = statements.slice(i, i + chunkSize).map(({ sql, args }) => ({
        sql,
        args: (args ?? []) as InArgs,
      }));
      await connection().batch(chunk, "write");
    }
  },

  /** Several statements at once, for schema work only — no user data here. */
  async exec(sql: string): Promise<void> {
    await connection().executeMultiple(sql);
  },
};

/** What every module that touches storage is handed. */
export type Db = typeof api;

let ready: Promise<void> | undefined;

/**
 * The database, with the schema guaranteed to exist.
 *
 * Serverless means many short-lived processes, so this is memoised per process
 * rather than run per request; the statements are all `IF NOT EXISTS`, so the
 * races between cold starts settle harmlessly.
 */
export async function getDb(): Promise<typeof api> {
  if (!ready) ready = migrate();
  await ready;
  return api;
}

async function migrate(): Promise<void> {
  await api.exec(`
    /* ---- accounts ----
       Every row that belongs to a person hangs off this table. An account is
       created silently on first visit and identified only by the random token
       in the session cookie, so there is no signup to get through. */
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT UNIQUE,
      claim_code   TEXT UNIQUE,
      email        TEXT UNIQUE,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS books (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      author       TEXT NOT NULL DEFAULT '',
      language     TEXT NOT NULL DEFAULT 'en',
      cover_url    TEXT,
      source       TEXT NOT NULL,
      source_id    TEXT,
      file_name    TEXT,
      file_ext     TEXT,
      word_count   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    /* The uploaded file itself. It used to sit on a mounted disk; there is no
       disk on a serverless host, and at a few hundred kilobytes a book it is
       cheaper to keep it here than to run a second service for it. Its own
       table so that listing a library never drags the bytes along. */
    CREATE TABLE IF NOT EXISTS book_files (
      book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      ext     TEXT NOT NULL,
      bytes   BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      idx      INTEGER NOT NULL,
      title    TEXT NOT NULL DEFAULT '',
      html     TEXT NOT NULL,
      UNIQUE (book_id, idx)
    );

    CREATE TABLE IF NOT EXISTS progress (
      book_id      INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      chapter_idx  INTEGER NOT NULL DEFAULT 0,
      scroll_pct   REAL NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    );

    /* Carries its own user_id rather than inheriting one through book_id: a word
       can be saved with no book attached, and a word saved from a book you later
       delete keeps its owner when book_id goes to NULL. */
    CREATE TABLE IF NOT EXISTS vocab (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id      INTEGER REFERENCES books(id) ON DELETE SET NULL,
      term         TEXT NOT NULL,
      lemma        TEXT NOT NULL DEFAULT '',
      translation  TEXT NOT NULL DEFAULT '',
      context      TEXT NOT NULL DEFAULT '',
      note         TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'word',
      box          INTEGER NOT NULL DEFAULT 1,
      due_at       INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      UNIQUE (user_id, term, book_id)
    );

    CREATE TABLE IF NOT EXISTS translation_cache (
      key        TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    /* ---- spaced repetition ----
       One vocab entry produces several cards, each scheduled on its own. */
    CREATE TABLE IF NOT EXISTS cards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vocab_id   INTEGER NOT NULL REFERENCES vocab(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      box        INTEGER NOT NULL DEFAULT 1,
      due_at     INTEGER NOT NULL DEFAULT 0,
      reps       INTEGER NOT NULL DEFAULT 0,
      lapses     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (vocab_id, type)
    );

    CREATE TABLE IF NOT EXISTS known_words (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lemma      TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, lemma)
    );

    CREATE TABLE IF NOT EXISTS book_words (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      lemma   TEXT NOT NULL,
      count   INTEGER NOT NULL,
      PRIMARY KEY (book_id, lemma)
    );

    CREATE TABLE IF NOT EXISTS book_index (
      book_id     INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      indexed_at  INTEGER NOT NULL,
      tokens      INTEGER NOT NULL DEFAULT 0,
      lemmas      INTEGER NOT NULL DEFAULT 0,
      version     INTEGER NOT NULL DEFAULT 0
    );

    /* ---- statistics ---- */
    CREATE TABLE IF NOT EXISTS reading_log (
      day     TEXT NOT NULL,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, book_id)
    );

    CREATE TABLE IF NOT EXISTS review_log (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day      TEXT NOT NULL,
      reviewed INTEGER NOT NULL DEFAULT 0,
      correct  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);
    CREATE INDEX IF NOT EXISTS idx_vocab_user ON vocab(user_id);
    CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_at);
    CREATE INDEX IF NOT EXISTS idx_book_words_lemma ON book_words(lemma);

    /* Full-text search over chapter text. Kept as its own table rather than an
       external-content index so the stored HTML stays the single source of
       truth and a rebuild is just "delete these rows and re-insert". */
    CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
      body,
      title,
      book_id UNINDEXED,
      idx UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

/**
 * Kept from the node:sqlite version, which returned null-prototype rows that
 * React refused to hand from a server component to a client one. libSQL rows
 * are already rebuilt as plain objects by `rowToObject()` above, so these only
 * exist so that every call site did not have to change to say so.
 */
export function plain<T>(row: T): T {
  return row;
}

export function plainAll<T>(rows: T[]): T[] {
  return rows;
}

/** Local calendar day, the key used by the stats tables. */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A one-time code that hands an account to whoever opens it.
 *
 * Kept here because it is the only way into an account that no browser holds —
 * which is what an imported library is until its owner claims it.
 */
export function mintClaimCode(): string {
  return randomBytes(16).toString("hex");
}
