import { createHash, randomInt } from "node:crypto";
import { type Db, type Tx } from "./db";

/**
 * Accounts, and which browsers are signed in to them.
 *
 * There is no login. `proxy.ts` gives every browser a random token, and the
 * first time we see one we open an account for it — so the reader gets a
 * private library by doing nothing, and can add a second browser to that
 * account later without ever having typed a password.
 *
 * A token is a bearer credential: anyone holding one is that account. So they
 * are stored hashed, one row per browser in `sessions`, and the way a second
 * browser joins an account is by presenting a code the first one minted — see
 * `mintLinkCode` and `joinAccount` below.
 *
 * Everything here takes a database and a token hash and touches no request
 * state, which is what `session.ts` is for. That split is not tidiness: the
 * interesting behaviour in this file is what happens when two requests race, or
 * when a claim half-succeeds, and neither can be tested through a cookie.
 */

/** Skip the write on most requests — `last_seen_at` is not worth a row update per fetch. */
const LAST_SEEN_RESOLUTION = 60 * 60 * 1000;

/** How long a "link another device" code is good for. */
export const LINK_CODE_TTL = 10 * 60 * 1000;

/** The stored form of a token. The database should not be holding live ones. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The account this token belongs to, opening one if the token is new. */
export async function userIdForToken(db: Db, hash: string): Promise<number> {
  const session = await db.get<{ user_id: number; last_seen_at: number }>(
    "SELECT user_id, last_seen_at FROM sessions WHERE token_hash = ?",
    hash,
  );

  if (session) {
    const now = Date.now();
    if (now - session.last_seen_at > LAST_SEEN_RESOLUTION) {
      await db.batch([
        { sql: "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", args: [now, hash] },
        { sql: "UPDATE users SET last_seen_at = ? WHERE id = ?", args: [now, session.user_id] },
      ]);
    }
    return session.user_id;
  }

  return createUser(db, hash);
}

/**
 * Open a new account for a token we have not seen before.
 *
 * Two requests can arrive carrying the same brand-new cookie — a page and the
 * fetch it fires, most often — and both will find no session and try to create
 * one. The account row cannot arbitrate that race any more now that the token
 * lives in another table, so `sessions` does: its primary key admits one
 * winner, and the loser reads back the winner's account and drops the empty
 * one it had just opened.
 */
async function createUser(db: Db, hash: string): Promise<number> {
  const now = Date.now();
  const created = await db.run(
    "INSERT INTO users (claim_code, claim_expires_at, email, created_at, last_seen_at) VALUES (NULL, NULL, NULL, ?, ?)",
    now,
    now,
  );
  const userId = created.lastInsertRowid;

  await db.run(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(token_hash) DO NOTHING`,
    hash,
    userId,
    now,
    now,
  );

  const session = await db.get<{ user_id: number }>(
    "SELECT user_id FROM sessions WHERE token_hash = ?",
    hash,
  );
  if (session && session.user_id !== userId) {
    await db.run("DELETE FROM users WHERE id = ?", userId);
    return session.user_id;
  }
  return userId;
}

/* ------------------------------ linking devices ----------------------------- */

/**
 * Unambiguous by design: no O against 0, no I or l against 1. The code is read
 * off one screen and typed into another, quite possibly across a room.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** The stored code, grouped for reading aloud and typing in. */
function forDisplay(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/**
 * A code that lets another browser join this account.
 *
 * Stored bare and shown in threes: the dashes are there to be read across a
 * room and are not part of the code, which is why an entered one is stripped
 * back down before it is compared.
 *
 * One at a time per account: minting a second replaces the first, so a code
 * left on a screen somewhere stops working as soon as the reader asks for
 * another. `claim_code` is unique across the table, so a collision — vanishingly
 * unlikely at 30^12, but the constraint is real — is retried rather than
 * thrown at the reader.
 */
export async function mintLinkCode(
  db: Db,
  userId: number,
): Promise<{ code: string; expiresAt: number }> {
  const expiresAt = Date.now() + LINK_CODE_TTL;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await db.run(
        "UPDATE users SET claim_code = ?, claim_expires_at = ? WHERE id = ?",
        code,
        expiresAt,
        userId,
      );
      return { code: forDisplay(code), expiresAt };
    } catch (err) {
      if (!/unique/i.test(String(err))) throw err;
    }
  }
  throw new Error("Could not create a link code. Try again.");
}

/**
 * Codes are typed by hand, so they arrive with the dashes left out, the case
 * wrong, or a space in the middle. The stored form is the canonical one; this
 * is what an entered one is compared as.
 */
export function normalizeCode(code: string): string {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/**
 * Sign the browser holding `hash` in to the account behind `code`.
 *
 * Two kinds of code arrive here and both are one-time. A reader who asked to
 * link a device is holding a fresh one with minutes left on it; a library that
 * predates accounts is reached with the code the migration printed to the
 * server log, which never expires because there is no moment at which it
 * becomes safe to assume it was seen.
 *
 * Deliberately not automatic — an account that adopts whoever turns up first
 * gets taken by the first health check instead.
 */
export async function joinAccount(db: Db, hash: string, code: string): Promise<boolean> {
  const entered = code.trim();
  if (!entered) return false;
  const normalized = normalizeCode(entered);

  // All of it in one transaction: the code is checked, spent, and the browser
  // attached in a single go, so two people racing to redeem the same code
  // cannot both find it unspent.
  return db.transaction(async (tx) => {
    const now = Date.now();
    const target = await tx.get<{ id: number }>(
      `SELECT id FROM users
        WHERE (claim_code = ? OR claim_code = ?)
          AND (claim_expires_at IS NULL OR claim_expires_at > ?)`,
      entered,
      normalized,
      now,
    );
    if (!target) return false;

    const session = await tx.get<{ user_id: number }>(
      "SELECT user_id FROM sessions WHERE token_hash = ?",
      hash,
    );
    const previousId = session?.user_id ?? null;

    await tx.run(
      "UPDATE users SET claim_code = NULL, claim_expires_at = NULL, last_seen_at = ? WHERE id = ?",
      now,
      target.id,
    );

    // Already this account — the reader redeemed their own code on the browser
    // that asked for it. The code is spent either way, which is the point.
    if (previousId === target.id) return true;

    await tx.run("DELETE FROM sessions WHERE token_hash = ?", hash);
    await tx.run(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      hash,
      target.id,
      now,
      now,
    );

    // Whatever account this browser was holding is folded into the one it just
    // joined, rather than left behind. Left behind, it would be unreachable —
    // no session points at it and its code is spent — so a reader who imported
    // a book on their phone before linking it would simply lose that book.
    if (previousId !== null) await merge(tx, previousId, target.id);

    return true;
  });
}

/**
 * Move everything owned by one account onto another, then delete the husk.
 *
 * Where a row would collide with one the target already has — the same word
 * saved on both devices, the same day reviewed on both — the two are reconciled
 * rather than the move being abandoned: counts add up, and a duplicate word
 * loses to the copy that is already there. Nothing here can leave rows on
 * `from`, because the account row is deleted at the end and everything cascades
 * off it; the point of each statement is to rescue the rows first.
 */
async function merge(tx: Tx, from: number, into: number): Promise<void> {
  // Other devices signed in to the old account follow it to the new one.
  await tx.run("UPDATE sessions SET user_id = ? WHERE user_id = ?", into, from);

  // Books carry their progress, chapters, index and reading log by book_id.
  await tx.run("UPDATE books SET user_id = ? WHERE user_id = ?", into, from);

  // A word saved on both devices is the same word twice, and the copy already
  // in the target account is the one whose review history is worth keeping. The
  // UNIQUE on vocab does not settle this by itself: its third column is
  // `book_id`, and SQLite counts two NULLs as different, so the copies saved
  // outside any book would both survive the move and show up twice in the list.
  await tx.run(
    `DELETE FROM vocab
      WHERE user_id = ? AND book_id IS NULL
        AND term IN (SELECT term FROM vocab WHERE user_id = ? AND book_id IS NULL)`,
    from,
    into,
  );
  await tx.run("UPDATE OR IGNORE vocab SET user_id = ? WHERE user_id = ?", into, from);
  await tx.run("UPDATE OR IGNORE known_words SET user_id = ? WHERE user_id = ?", into, from);

  // Two days of review counts for the same day are one day's reading, so these
  // add rather than one winning.
  await tx.run(
    `INSERT INTO review_log (user_id, day, reviewed, correct)
     SELECT ?, day, reviewed, correct FROM review_log WHERE user_id = ?
     ON CONFLICT (user_id, day) DO UPDATE
       SET reviewed = reviewed + excluded.reviewed,
           correct  = correct  + excluded.correct`,
    into,
    from,
  );

  await tx.run("DELETE FROM users WHERE id = ?", from);
}
