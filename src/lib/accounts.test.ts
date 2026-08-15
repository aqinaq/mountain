import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";

/**
 * Accounts, against a real SQLite database rather than a stand-in for one.
 *
 * Every interesting thing in `accounts.ts` is a thing the database does — a
 * primary key deciding a race, a transaction refusing to spend a code twice, a
 * cascade taking chapters with a book. A mocked `db` would answer to whatever
 * this file believed about those, which is exactly the belief worth testing.
 *
 * The connection string is pointed at a throwaway file before `db.ts` is
 * imported, because it reads the environment once at module load. Set rather
 * than defaulted: left alone it would fall back to `./data/reader.db`, which is
 * the database the developer is actually reading their books out of.
 *
 * A file and not `:memory:`, which looks like the obvious choice and is not —
 * libSQL's local driver opens a fresh connection for `transaction()`, and a
 * fresh connection to an in-memory database is a fresh, empty database. Half
 * the file is about transactions.
 */
const DB_DIR = mkdtempSync(join(tmpdir(), "mountain-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(DB_DIR, "test.db")}`;
delete process.env.TURSO_AUTH_TOKEN;

after(() => rmSync(DB_DIR, { recursive: true, force: true }));

type Db = Awaited<ReturnType<typeof import("./db").getDb>>;
type Accounts = typeof import("./accounts");

let db: Db;
let accounts: Accounts;

before(async () => {
  const { getDb } = await import("./db");
  accounts = await import("./accounts");
  db = await getDb();
});

beforeEach(async () => {
  for (const table of ["sessions", "vocab", "books", "known_words", "review_log", "users"]) {
    await db.run(`DELETE FROM ${table}`);
  }
});

const hash = (name: string) => accounts.hashToken(name);

async function countOf(table: string, where = "", ...args: unknown[]): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} ${where ? `WHERE ${where}` : ""}`,
    ...args,
  );
  return row?.n ?? 0;
}

async function addBook(userId: number, title: string): Promise<number> {
  const { lastInsertRowid } = await db.run(
    "INSERT INTO books (user_id, title, source, created_at) VALUES (?, ?, 'upload', ?)",
    userId,
    title,
    Date.now(),
  );
  return lastInsertRowid;
}

async function addWord(userId: number, term: string, bookId: number | null = null) {
  await db.run(
    "INSERT INTO vocab (user_id, book_id, term, created_at) VALUES (?, ?, ?, ?)",
    userId,
    bookId,
    term,
    Date.now(),
  );
}

/* --------------------------------- sessions -------------------------------- */

test("a new token opens an account, and the same token finds it again", async () => {
  const first = await accounts.userIdForToken(db, hash("a"));
  const second = await accounts.userIdForToken(db, hash("a"));

  assert.equal(first, second);
  assert.equal(await countOf("users"), 1);
  assert.equal(await countOf("sessions"), 1);
});

test("two requests carrying the same brand-new token do not open two accounts", async () => {
  // The page and the fetch it fires arrive together, both holding a cookie
  // neither has been able to register yet. Whoever loses must find the winner's
  // account and leave no empty one behind.
  const ids = await Promise.all(
    Array.from({ length: 8 }, () => accounts.userIdForToken(db, hash("racing"))),
  );

  assert.equal(new Set(ids).size, 1, "every caller should end up on one account");
  assert.equal(await countOf("users"), 1, "no abandoned account rows");
  assert.equal(await countOf("sessions"), 1);
});

test("different tokens get different accounts", async () => {
  const a = await accounts.userIdForToken(db, hash("a"));
  const b = await accounts.userIdForToken(db, hash("b"));

  assert.notEqual(a, b);
  assert.equal(await countOf("users"), 2);
});

/* ------------------------------- link codes -------------------------------- */

test("a link code is typeable and unambiguous", async () => {
  const userId = await accounts.userIdForToken(db, hash("laptop"));
  const { code, expiresAt } = await accounts.mintLinkCode(db, userId);

  assert.match(code, /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
  assert.doesNotMatch(code, /[01ILOU]/, "characters that get misread should not appear");
  assert.ok(expiresAt > Date.now());
});

test("minting a code replaces the one before it", async () => {
  const userId = await accounts.userIdForToken(db, hash("laptop"));
  const first = await accounts.mintLinkCode(db, userId);
  const second = await accounts.mintLinkCode(db, userId);

  assert.notEqual(first.code, second.code);
  assert.equal(await accounts.joinAccount(db, hash("phone"), first.code), false);
  assert.equal(await accounts.joinAccount(db, hash("phone"), second.code), true);
});

/* --------------------------------- joining --------------------------------- */

test("a second device joins the account and both stay signed in", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  await addBook(laptop, "Middlemarch");
  const { code } = await accounts.mintLinkCode(db, laptop);

  assert.equal(await accounts.joinAccount(db, hash("phone"), code), true);

  assert.equal(await accounts.userIdForToken(db, hash("phone")), laptop);
  assert.equal(await accounts.userIdForToken(db, hash("laptop")), laptop);
  assert.equal(await countOf("sessions", "user_id = ?", laptop), 2);
});

test("a code works once", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const { code } = await accounts.mintLinkCode(db, laptop);

  assert.equal(await accounts.joinAccount(db, hash("phone"), code), true);
  assert.equal(await accounts.joinAccount(db, hash("stranger"), code), false);

  // The stranger is left on their own account, not on the reader's.
  assert.notEqual(await accounts.userIdForToken(db, hash("stranger")), laptop);
});

test("only one of several devices racing for the same code gets in", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const { code } = await accounts.mintLinkCode(db, laptop);

  const results = await Promise.all([
    accounts.joinAccount(db, hash("phone"), code),
    accounts.joinAccount(db, hash("tablet"), code),
    accounts.joinAccount(db, hash("stranger"), code),
  ]);

  assert.equal(results.filter(Boolean).length, 1, "the code is spent exactly once");
});

test("an expired code is refused", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const { code } = await accounts.mintLinkCode(db, laptop);
  await db.run("UPDATE users SET claim_expires_at = ? WHERE id = ?", Date.now() - 1, laptop);

  assert.equal(await accounts.joinAccount(db, hash("phone"), code), false);
});

test("a code is accepted however it was typed", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const { code } = await accounts.mintLinkCode(db, laptop);

  const mangled = ` ${code.toLowerCase().replace(/-/g, " ")} `;
  assert.equal(await accounts.joinAccount(db, hash("phone"), mangled), true);
});

test("the code the accounts migration printed still works, and never expires", async () => {
  // Lower-case hex with no dashes, stored with no expiry — the shape the old
  // migration wrote. Nothing holds a session for it.
  const { lastInsertRowid: orphan } = await db.run(
    "INSERT INTO users (claim_code, claim_expires_at, created_at, last_seen_at) VALUES (?, NULL, ?, ?)",
    "7342bce6f0a14d2b9c5e",
    0,
    0,
  );
  await addBook(orphan, "A library that predates accounts");

  assert.equal(await accounts.joinAccount(db, hash("laptop"), "7342bce6f0a14d2b9c5e"), true);
  assert.equal(await accounts.userIdForToken(db, hash("laptop")), orphan);
});

test("nonsense is refused without opening or moving anything", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));

  assert.equal(await accounts.joinAccount(db, hash("laptop"), ""), false);
  assert.equal(await accounts.joinAccount(db, hash("laptop"), "  "), false);
  assert.equal(await accounts.joinAccount(db, hash("laptop"), "ZZZZ-ZZZZ-ZZZZ"), false);
  assert.equal(await accounts.userIdForToken(db, hash("laptop")), laptop);
  assert.equal(await countOf("users"), 1);
});

test("redeeming your own code on the device that made it is harmless", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const { code } = await accounts.mintLinkCode(db, laptop);

  assert.equal(await accounts.joinAccount(db, hash("laptop"), code), true);
  assert.equal(await accounts.userIdForToken(db, hash("laptop")), laptop);
  assert.equal(await countOf("sessions", "user_id = ?", laptop), 1);
  // Spent, all the same.
  assert.equal(await accounts.joinAccount(db, hash("phone"), code), false);
});

/* --------------------------------- merging --------------------------------- */

test("what the joining device already had comes with it", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  await addBook(laptop, "Middlemarch");
  await addWord(laptop, "quotidian");

  const phone = await accounts.userIdForToken(db, hash("phone"));
  await addBook(phone, "An article read on the train");
  await addWord(phone, "shibboleth");

  const { code } = await accounts.mintLinkCode(db, laptop);
  assert.equal(await accounts.joinAccount(db, hash("phone"), code), true);

  assert.equal(await countOf("books", "user_id = ?", laptop), 2);
  assert.equal(await countOf("vocab", "user_id = ?", laptop), 2);
  assert.equal(await countOf("users"), 1, "the emptied account is gone");
  assert.equal(await countOf("books", "user_id = ?", phone), 0);
});

test("a word saved on both devices does not break the merge", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  await addWord(laptop, "shibboleth");
  await db.run(
    "INSERT INTO known_words (user_id, lemma, created_at) VALUES (?, 'the', ?)",
    laptop,
    Date.now(),
  );

  const phone = await accounts.userIdForToken(db, hash("phone"));
  await addWord(phone, "shibboleth");
  await addWord(phone, "quotidian");
  await db.run(
    "INSERT INTO known_words (user_id, lemma, created_at) VALUES (?, 'the', ?)",
    phone,
    Date.now(),
  );

  const { code } = await accounts.mintLinkCode(db, laptop);
  assert.equal(await accounts.joinAccount(db, hash("phone"), code), true);

  assert.equal(await countOf("vocab", "user_id = ?", laptop), 2, "the duplicate is not doubled");
  assert.equal(await countOf("known_words", "user_id = ?", laptop), 1);
  assert.equal(await countOf("users"), 1);
});

test("review counts for the same day are added together", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const phone = await accounts.userIdForToken(db, hash("phone"));
  for (const [userId, reviewed, correct] of [
    [laptop, 10, 8],
    [phone, 5, 3],
  ]) {
    await db.run(
      "INSERT INTO review_log (user_id, day, reviewed, correct) VALUES (?, '2026-08-15', ?, ?)",
      userId,
      reviewed,
      correct,
    );
  }

  const { code } = await accounts.mintLinkCode(db, laptop);
  await accounts.joinAccount(db, hash("phone"), code);

  const row = await db.get<{ reviewed: number; correct: number }>(
    "SELECT reviewed, correct FROM review_log WHERE user_id = ? AND day = '2026-08-15'",
    laptop,
  );
  assert.deepEqual(row, { reviewed: 15, correct: 11 });
  assert.equal(await countOf("review_log"), 1);
});

test("every device on the merged account follows it", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  const phone = await accounts.userIdForToken(db, hash("phone"));
  await accounts.userIdForToken(db, hash("phone-2")); // a third, separate account

  // The phone links its own second browser first, then the whole thing joins
  // the laptop's library.
  const phoneCode = await accounts.mintLinkCode(db, phone);
  await accounts.joinAccount(db, hash("phone-2"), phoneCode.code);

  const { code } = await accounts.mintLinkCode(db, laptop);
  await accounts.joinAccount(db, hash("phone"), code);

  assert.equal(await accounts.userIdForToken(db, hash("phone-2")), laptop);
  assert.equal(await countOf("sessions", "user_id = ?", laptop), 3);
  assert.equal(await countOf("users"), 1);
});

test("a failed join leaves the transaction with nothing half-done", async () => {
  const laptop = await accounts.userIdForToken(db, hash("laptop"));
  await addBook(laptop, "Middlemarch");
  const phone = await accounts.userIdForToken(db, hash("phone"));
  await addBook(phone, "Something else");

  assert.equal(await accounts.joinAccount(db, hash("phone"), "WRONG-CODE-HERE"), false);

  assert.equal(await accounts.userIdForToken(db, hash("phone")), phone);
  assert.equal(await countOf("books", "user_id = ?", phone), 1);
  assert.equal(await countOf("books", "user_id = ?", laptop), 1);
  assert.equal(await countOf("users"), 2);
});
