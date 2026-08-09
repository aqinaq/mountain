/**
 * Copy the local library into Turso.
 *
 * Both ends are SQLite, so this is a straight row-for-row copy rather than a
 * conversion — the schema on the far end is the one the app itself creates on
 * first run, and the ids are carried across unchanged so that everything
 * pointing at a book id still points at the same book.
 *
 *   TURSO_DATABASE_URL=libsql://…  TURSO_AUTH_TOKEN=…  node scripts/push-to-turso.mjs
 *
 * Start the app against the Turso URL once before running this: the app owns
 * the schema, and this script deliberately does not, so there is only ever one
 * definition of what the tables look like.
 *
 * Safe to re-run. Every table is emptied before it is refilled, so a failed
 * run halfway through does not leave the far end holding two of everything.
 */
import { createClient } from "@libsql/client";
import fs from "node:fs/promises";
import path from "node:path";

const localPath = process.argv[2] ?? path.join(process.cwd(), "data", "reader.db");
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("Set TURSO_DATABASE_URL to the target database.");
  process.exit(1);
}

// The hazard worth guarding is not a local target — that is a useful thing to
// have, both for a backup and for rehearsing this before it touches Turso —
// but a target that is the source, which would empty the library and then
// copy it from the nothing it had just made.
if (url.startsWith("file:") && path.resolve(url.slice(5)) === path.resolve(localPath)) {
  console.error("Source and target are the same database.");
  process.exit(1);
}

const local = createClient({ url: `file:${localPath}`, intMode: "number" });
const remote = createClient({ url, authToken, intMode: "number" });

/**
 * Order matters: a child row cannot be written before the row it references,
 * and the deletes have to run the other way round for the same reason.
 */
const TABLES = [
  "users",
  "books",
  "book_files",
  "chapters",
  "progress",
  "vocab",
  "cards",
  "known_words",
  "book_words",
  "book_index",
  "reading_log",
  "review_log",
];

async function columnsOf(client, table) {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  return info.rows.map((r) => String(r.name));
}

async function main() {
  // The far end must already have been built by the app.
  const existing = new Set(
    (
      await remote.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).rows.map((r) => String(r.name)),
  );
  const missing = TABLES.filter((t) => !existing.has(t));
  if (missing.length) {
    console.error(
      `The target database is missing ${missing.join(", ")}.\n` +
        `Start the app once against TURSO_DATABASE_URL so it can create the schema, then re-run.`,
    );
    process.exit(1);
  }

  // Clear children before parents so foreign keys never block a delete.
  for (const table of [...TABLES].reverse()) {
    await remote.execute(`DELETE FROM ${table}`);
  }
  await remote.execute("DELETE FROM chapters_fts");

  let grand = 0;
  for (const table of TABLES) {
    const localCols = await columnsOf(local, table);
    const remoteCols = new Set(await columnsOf(remote, table));
    // Only what both ends agree exists — the local database has been through
    // migrations the fresh one never had.
    const cols = localCols.filter((c) => remoteCols.has(c));

    const { rows } = await local.execute(`SELECT ${cols.join(", ")} FROM ${table}`);
    if (!rows.length) {
      console.log(`  ${table.padEnd(14)} 0`);
      continue;
    }

    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const statements = rows.map((row) => ({ sql, args: cols.map((c) => row[c] ?? null) }));

    // Chunked: book_words alone is tens of thousands of rows, and a batch is
    // held in memory at both ends before it commits.
    for (let i = 0; i < statements.length; i += 500) {
      await remote.batch(statements.slice(i, i + 500), "write");
    }

    grand += rows.length;
    console.log(`  ${table.padEnd(14)} ${rows.length}`);
  }

  // The uploaded originals, which on the old single-machine version were
  // written to a directory beside the database rather than into it. They are
  // only reachable through books.file_name, so they have to be carried across
  // separately or the download button loses the file it was pointing at.
  const filesDir = path.join(path.dirname(localPath), "files");
  const uploads = await local.execute(
    "SELECT id, file_name, file_ext FROM books WHERE file_name IS NOT NULL",
  );

  let carried = 0;
  for (const row of uploads.rows) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(filesDir, String(row.file_name)));
    } catch {
      // A row pointing at a file that is no longer there. The book still
      // reads — the chapters are in the database — so this is not fatal.
      console.warn(`  ! missing upload for book ${row.id}: ${row.file_name}`);
      continue;
    }
    await remote.execute({
      sql: "INSERT OR REPLACE INTO book_files (book_id, ext, bytes) VALUES (?, ?, ?)",
      args: [row.id, String(row.file_ext ?? "bin"), bytes],
    });
    carried++;
  }
  if (uploads.rows.length) console.log(`  ${"book_files".padEnd(14)} ${carried} (from disk)`);

  // The search index is derived, not copied: it is a virtual table whose
  // shadow tables would not survive a row-for-row copy, and the app rebuilds
  // it for any book whose index version does not match.
  await remote.execute("UPDATE book_index SET version = 0");

  console.log(`\n${grand} rows copied. The search index will rebuild on first read.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
