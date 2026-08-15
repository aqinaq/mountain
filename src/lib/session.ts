import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { hashToken, joinAccount, userIdForToken } from "./accounts";
import { getDb } from "./db";
import { SESSION_COOKIE } from "./session-cookie";

/**
 * The request half of accounts: read the cookie, hand the token to
 * `accounts.ts`, which knows what an account is and nothing about requests.
 *
 * Route handlers import from here. Everything with logic in it lives on the
 * other side of that line, where it can be run without a request to hang it on.
 */

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
  return userIdForToken(db, hashToken(token));
}

/** Sign this browser in to the account that minted `code`. */
export async function claimAccount(code: string): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !code) return false;

  const db = await getDb();
  return joinAccount(db, hashToken(token), code);
}

export { mintLinkCode } from "./accounts";

/** The reply for a request with no session, for route handlers to return as-is. */
export function noSession() {
  return NextResponse.json(
    { error: "No session. Reload the app so it can start one." },
    { status: 401 },
  );
}
