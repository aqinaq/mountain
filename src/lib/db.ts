import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const FILES_DIR = path.join(DATA_DIR, "files");

fs.mkdirSync(FILES_DIR, { recursive: true });

// Next dev reloads modules; keep one handle on globalThis so we don't leak
// connections or re-run migrations on every hot reload.
const g = globalThis as unknown as { __readerDb?: DatabaseSync };

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Add a column to an existing table, for databases created before it existed. */
function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string) {
  if (!columnNames(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function rowCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * Copy a single-user table into its multi-user shape, handing every existing
 * row to `ownerId`. SQLite cannot alter a primary key or a unique constraint in
 * place, so `known_words`, `review_log` and `vocab` have to be rebuilt.
 *
 * Row ids are copied across verbatim: `cards.vocab_id` points at them.
 */
function rebuildWithOwner(
  db: DatabaseSync,
  table: string,
  createNew: string,
  columns: string[],
  ownerId: number,
) {
  const carried = columns.filter((c) => columnNames(db, table).includes(c));
  db.exec(createNew);
  db.prepare(
    `INSERT INTO ${table}_new (user_id, ${carried.join(", ")})
     SELECT ?, ${carried.join(", ")} FROM ${table}`,
  ).run(ownerId);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
}

/**
 * Give a database written before accounts existed a single owner.
 *
 * That owner starts out held by nobody, and the one-time code printed below is
 * the only way into it — so the books, words and streak already in the database
 * survive the upgrade, and land in the browser of whoever is actually running
 * this rather than whoever knocks first. An earlier version of this handed the
 * account to the first request that arrived, which a health check or a crawler
 * would happily consume before the reader ever opened a tab.
 */
function addAccounts(db: DatabaseSync) {
  const legacy = ["books", "vocab", "known_words", "review_log"].filter(
    (t) => !columnNames(db, t).includes("user_id"),
  );
  if (!legacy.length) return;

  const rows = legacy.reduce((n, t) => n + rowCount(db, t), 0);
  let claimUrl = "";

  // The rebuilds below drop tables that `cards` and `vocab` point at, and a
  // cascade partway through would take real rows with it. `foreign_keys` is a
  // no-op inside a transaction, so it has to be set out here.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    // Nothing to inherit means nothing to adopt: a database that was created
    // but never read from should not hand a stranger an account.
    const ownerId = rows
      ? Number(
          db
            .prepare(
              "INSERT INTO users (token_hash, email, created_at, last_seen_at) VALUES (NULL, NULL, ?, ?)",
            )
            .run(Date.now(), Date.now()).lastInsertRowid,
        )
      : 0;

    // Printed once, below. Not derived from anything guessable: it is the only
    // credential standing between a fresh visitor and the whole library.
    const claimCode = randomBytes(16).toString("hex");
    if (ownerId) {
      db.prepare("UPDATE users SET claim_code = ? WHERE id = ?").run(claimCode, ownerId);
      claimUrl = claimCode;
    }

    if (legacy.includes("books")) {
      // SQLite refuses ADD COLUMN with both a REFERENCES clause and a non-NULL
      // default, so this one column carries no foreign key. Fresh databases get
      // it from the CREATE above; here the queries are the only enforcement.
      db.exec("ALTER TABLE books ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0");
      db.prepare("UPDATE books SET user_id = ?").run(ownerId);
    }

    if (legacy.includes("known_words")) {
      rebuildWithOwner(
        db,
        "known_words",
        `CREATE TABLE known_words_new (
           user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           lemma      TEXT NOT NULL,
           source     TEXT NOT NULL DEFAULT 'manual',
           created_at INTEGER NOT NULL,
           PRIMARY KEY (user_id, lemma)
         )`,
        ["lemma", "source", "created_at"],
        ownerId,
      );
    }

    if (legacy.includes("review_log")) {
      rebuildWithOwner(
        db,
        "review_log",
        `CREATE TABLE review_log_new (
           user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           day      TEXT NOT NULL,
           reviewed INTEGER NOT NULL DEFAULT 0,
           correct  INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (user_id, day)
         )`,
        ["day", "reviewed", "correct"],
        ownerId,
      );
    }

    if (legacy.includes("vocab")) {
      rebuildWithOwner(
        db,
        "vocab",
        `CREATE TABLE vocab_new (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           book_id      INTEGER REFERENCES books(id) ON DELETE SET NULL,
           term         TEXT NOT NULL,
           translation  TEXT NOT NULL DEFAULT '',
           context      TEXT NOT NULL DEFAULT '',
           note         TEXT NOT NULL DEFAULT '',
           kind         TEXT NOT NULL DEFAULT 'word',
           lemma        TEXT NOT NULL DEFAULT '',
           box          INTEGER NOT NULL DEFAULT 1,
           due_at       INTEGER NOT NULL DEFAULT 0,
           created_at   INTEGER NOT NULL,
           UNIQUE (user_id, term, book_id)
         )`,
        ["id", "book_id", "term", "translation", "context", "note", "kind", "lemma", "box", "due_at", "created_at"],
        ownerId,
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw err;
  }

  const broken = db.prepare("PRAGMA foreign_key_check").all();
  db.exec("PRAGMA foreign_keys = ON");
  if (broken.length) {
    console.warn(`[mountain] ${broken.length} rows lost their parent during the accounts migration.`);
  }
  if (claimUrl) {
    console.info(
      `\n[mountain] Accounts added. Everything already in this database is held by an\n` +
        `           account nobody owns yet. Open this once, in the browser you read in,\n` +
        `           to take it:\n\n           /claim?code=${claimUrl}\n\n` +
        `           The code works once and is not stored anywhere else.\n`,
    );
  }
}

function open(): DatabaseSync {
  const db = new DatabaseSync(path.join(DATA_DIR, "reader.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    /* ---- accounts ----
       Every row that belongs to a person hangs off this table. An account is
       created silently on first visit and identified only by the random token
       in the session cookie, so there is no signup to get through. The email
       column is where a claimed account would record who it belongs to. */
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT UNIQUE,       -- SHA-256 of the cookie; NULL = nobody holds this account
      claim_code   TEXT UNIQUE,       -- one-time code that hands the account to a browser
      email        TEXT UNIQUE,       -- NULL until the account is attached to a person
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    /* A book belongs to one account, and everything derived from it — chapters,
       progress, the word index, the search index, reading time — is scoped by
       being reached through it. Two people importing the same title get a row
       each; the text is stored twice, which is the price of not having to
       reconcile one shared copy against two libraries. */
    CREATE TABLE IF NOT EXISTS books (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      author       TEXT NOT NULL DEFAULT '',
      language     TEXT NOT NULL DEFAULT 'en',
      cover_url    TEXT,
      source       TEXT NOT NULL,              -- 'upload' | 'gutenberg' | 'web'
      source_id    TEXT,                       -- gutenberg id or article URL
      file_name    TEXT,                       -- stored original, for download
      file_ext     TEXT,
      word_count   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
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
      translation  TEXT NOT NULL DEFAULT '',
      context      TEXT NOT NULL DEFAULT '',
      note         TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'word', -- 'word' | 'phrase'
      box          INTEGER NOT NULL DEFAULT 1,   -- legacy; scheduling lives in cards
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
       One vocab entry produces several cards, each scheduled on its own:
       'recognize' (English → your language), 'produce' (the other way round,
       which is the harder and more useful direction) and 'cloze' (the sentence
       the word was met in, with the word blanked out). */
    CREATE TABLE IF NOT EXISTS cards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vocab_id   INTEGER NOT NULL REFERENCES vocab(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,                 -- 'recognize' | 'produce' | 'cloze'
      box        INTEGER NOT NULL DEFAULT 1,    -- Leitner box, 1..5
      due_at     INTEGER NOT NULL DEFAULT 0,
      reps       INTEGER NOT NULL DEFAULT 0,
      lapses     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (vocab_id, type)
    );

    /* ---- word knowledge ----
       Lemmas the reader has told us they already know, either by marking them
       or by accepting the common-word seed list. */
    CREATE TABLE IF NOT EXISTS known_words (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lemma      TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'seed'
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, lemma)
    );

    /* Per-book lemma counts, written once when a book is indexed. This is what
       makes "you know 94% of this book" and "commonest words you don't know"
       answerable with one query. */
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
      lemmas      INTEGER NOT NULL DEFAULT 0
    );

    /* ---- statistics ---- */
    CREATE TABLE IF NOT EXISTS reading_log (
      day     TEXT NOT NULL,                    -- local YYYY-MM-DD
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
  `);

  // Columns added after the first release.
  ensureColumn(db, "vocab", "lemma", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "book_index", "version", "INTEGER NOT NULL DEFAULT 0");
  // ALTER TABLE cannot carry a UNIQUE constraint, so the index does that job.
  ensureColumn(db, "users", "claim_code", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_claim_code ON users(claim_code)");

  // Runs before the indexes, which the rebuilt tables would otherwise lose.
  addAccounts(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);
    CREATE INDEX IF NOT EXISTS idx_vocab_user ON vocab(user_id);
    CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_at);
    CREATE INDEX IF NOT EXISTS idx_book_words_lemma ON book_words(lemma);
  `);

  // Full-text search over chapter text. Kept as its own table rather than an
  // external-content index so the stored HTML stays the single source of truth
  // and a rebuild is just "delete these rows and re-insert".
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
      body,
      title,
      book_id UNINDEXED,
      idx UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  return db;
}

export function getDb(): DatabaseSync {
  if (!g.__readerDb) g.__readerDb = open();
  return g.__readerDb;
}

/**
 * node:sqlite hands back null-prototype objects, which React refuses to pass
 * from a server component to a client one. Re-spread them into plain objects.
 */
export function plain<T>(row: T): T {
  return { ...row };
}

export function plainAll<T>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r }));
}

/** Local calendar day, the key used by the stats tables. */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
