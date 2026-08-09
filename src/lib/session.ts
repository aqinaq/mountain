import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb, type Db } from "./db";
import { SESSION_COOKIE } from "./session-cookie";

/**
 * Who is asking.
 *
 * There is no login. `proxy.ts` gives every browser a random token, and the
 * first time we see one we open an account for it — so the reader gets a
 * private library by doing nothing, and the row is there to attach an email to
 * later if they ever want their words on a second device.
 *
 * The token is stored hashed. It is a bearer credential: anyone holding one is
 * that account, so the database should not be holding live ones.
 */

/** Skip the write on most requests — `last_seen_at` is not worth a row update per fetch. */
const LAST_SEEN_RESOLUTION = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The account for this session, opening one if this token is new.
 *
 * Returns null only when the request carried no cookie at all, which means it
 * did not come through the proxy — a bare `curl`, or a fetch that dropped
 * credentials. There is nothing sensible to do with such a request but refuse
 * it, and inventing an account for each one would fill the table with rows
 * nobody can ever reach again.
 */
export async function currentUserId(): Promise<number | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = await getDb();
  const hash = hashToken(token);

  const existing = await db.get<{ id: number; last_seen_at: number }>(
    "SELECT id, last_seen_at FROM users WHERE token_hash = ?",
    hash,
  );
  if (existing) {
    const now = Date.now();
    if (now - existing.last_seen_at > LAST_SEEN_RESOLUTION) {
      await db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, existing.id);
    }
    return existing.id;
  }

  return createUser(db, hash);
}

/** Open a new account for a token we have not seen before. */
async function createUser(db: Db, hash: string): Promise<number> {
  const now = Date.now();
  // ON CONFLICT rather than a bare INSERT: two requests can arrive carrying the
  // same brand-new cookie, and the loser of that race should find the winner's
  // account rather than fail.
  await db.run(
    `INSERT INTO users (token_hash, claim_code, email, created_at, last_seen_at) VALUES (?, NULL, NULL, ?, ?)
     ON CONFLICT(token_hash) DO NOTHING`,
    hash,
    now,
    now,
  );

  const created = await db.get<{ id: number }>("SELECT id FROM users WHERE token_hash = ?", hash);
  return created!.id;
}

/**
 * Hand the account behind `code` to the browser making this request.
 *
 * This is how a library that predates accounts reaches its owner: the migration
 * prints the code to the server log, and whoever can read that log is the
 * person running the app. Deliberately not automatic — an account that adopts
 * whoever turns up first gets taken by the first health check instead.
 */
export async function claimAccount(code: string): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !code) return false;

  const db = await getDb();
  const hash = hashToken(token);

  const target = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE claim_code = ? AND token_hash IS NULL",
    code,
  );
  if (!target) return false;

  // Whatever account this browser is already holding is about to be let go of.
  // It is worth deleting only if nothing was ever put in it — otherwise the
  // reader would silently lose the words they saved before claiming.
  const previous = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE token_hash = ?",
    hash,
  );

  await db.exec("BEGIN");
  try {
    if (previous && previous.id !== target.id) {
      await db.run("UPDATE users SET token_hash = NULL WHERE id = ?", previous.id);
      if (await isEmptyAccount(db, previous.id)) {
        await db.run("DELETE FROM users WHERE id = ?", previous.id);
      }
    }
    // The code is spent in the same transaction that grants the account, so it
    // cannot be replayed by anyone else who saw the log.
    await db.run(
      "UPDATE users SET token_hash = ?, claim_code = NULL, last_seen_at = ? WHERE id = ?",
      hash,
      Date.now(),
      target.id,
    );
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return true;
}

/** An account holding nothing at all, and so safe to drop on the floor. */
async function isEmptyAccount(db: Db, userId: number): Promise<boolean> {
  for (const table of ["books", "vocab", "known_words", "review_log"]) {
    const present = await db.get(`SELECT 1 AS present FROM ${table} WHERE user_id = ? LIMIT 1`, userId);
    if (present) return false;
  }
  return true;
}

/** The reply for a request with no session, for route handlers to return as-is. */
export function noSession() {
  return NextResponse.json(
    { error: "No session. Reload the app so it can start one." },
    { status: 401 },
  );
}
