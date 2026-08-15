import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createClient } from "@libsql/client";

/**
 * A database written by the version that kept one token per account, opened by
 * this one.
 *
 * The schema is created with `IF NOT EXISTS`, which does nothing at all to a
 * table that is already there — so the two changes to `users` are made by hand
 * and this is the only thing that says they were made correctly. The reader
 * whose deployment is being upgraded should stay signed in; the whole point is
 * that they notice nothing.
 *
 * Its own file because `db.ts` reads the connection string once and memoises
 * the migration, and the point here is to watch that run exactly once.
 */
const DB_DIR = mkdtempSync(join(tmpdir(), "mountain-migration-"));
const DB_PATH = join(DB_DIR, "old.db");
process.env.TURSO_DATABASE_URL = `file:${DB_PATH}`;
delete process.env.TURSO_AUTH_TOKEN;

after(() => rmSync(DB_DIR, { recursive: true, force: true }));

const SIGNED_IN = "a".repeat(64); // a token hash, as the old version stored it
const LEGACY_CODE = "7342bce6f0a14d2b";

let signedInId: number;
let orphanId: number;

before(async () => {
  const old = createClient({ url: `file:${DB_PATH}` });
  await old.executeMultiple(`
    CREATE TABLE users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT UNIQUE,
      claim_code   TEXT UNIQUE,
      email        TEXT UNIQUE,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `);
  const signedIn = await old.execute({
    sql: "INSERT INTO users (token_hash, created_at, last_seen_at) VALUES (?, 1000, 2000)",
    args: [SIGNED_IN],
  });
  signedInId = Number(signedIn.lastInsertRowid);

  // A library the migration left waiting for its owner, reachable only by the
  // code printed to the log.
  const orphan = await old.execute({
    sql: "INSERT INTO users (claim_code, created_at, last_seen_at) VALUES (?, 1000, 2000)",
    args: [LEGACY_CODE],
  });
  orphanId = Number(orphan.lastInsertRowid);
  old.close();
});

test("an account that held its own token keeps its books and its sign-in", async () => {
  const { getDb } = await import("./db");
  const { userIdForToken } = await import("./accounts");
  const db = await getDb();

  // The browser holding that token is still the same account, without having
  // been asked for anything.
  assert.equal(await userIdForToken(db, SIGNED_IN), signedInId);

  const session = await db.get<{ user_id: number; created_at: number }>(
    "SELECT user_id, created_at FROM sessions WHERE token_hash = ?",
    SIGNED_IN,
  );
  assert.equal(session?.user_id, signedInId);
  assert.equal(session?.created_at, 1000, "the session inherits when the account was opened");

  // And the column it came out of is empty, so a second run has nothing to do
  // and an unlinked device cannot be resurrected by one.
  const row = await db.get<{ token_hash: string | null }>(
    "SELECT token_hash FROM users WHERE id = ?",
    signedInId,
  );
  assert.equal(row?.token_hash, null);
});

test("the expiry column is added, and the code printed before it existed still works", async () => {
  const { getDb } = await import("./db");
  const { joinAccount, userIdForToken } = await import("./accounts");
  const db = await getDb();

  const columns = await db.all<{ name: string }>("PRAGMA table_info(users)");
  assert.ok(columns.some((c) => c.name === "claim_expires_at"));

  // Null expiry, and it must be read as "no expiry" rather than "expired".
  const before = await db.get<{ claim_expires_at: number | null }>(
    "SELECT claim_expires_at FROM users WHERE id = ?",
    orphanId,
  );
  assert.equal(before?.claim_expires_at, null);

  assert.equal(await joinAccount(db, "b".repeat(64), LEGACY_CODE), true);
  assert.equal(await userIdForToken(db, "b".repeat(64)), orphanId);
});

test("running the migration again changes nothing", async () => {
  const { getDb } = await import("./db");
  const db = await getDb();

  const sessions = await db.all<{ token_hash: string }>("SELECT token_hash FROM sessions");
  assert.equal(sessions.length, 2, "one for the upgraded account, one for the claimed one");

  // The old column stays empty rather than being re-copied out of.
  const stale = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE token_hash IS NOT NULL",
  );
  assert.equal(stale?.n, 0);
});
