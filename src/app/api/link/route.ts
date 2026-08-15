import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { currentUserId, mintLinkCode, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mint a code that adds another browser to this account.
 *
 * A POST rather than a GET, and not because it is fashionable: this replaces
 * whatever code the account was holding, so a prefetch or a crawler following a
 * link must not be able to invalidate the code the reader is in the middle of
 * typing into their phone.
 */
export async function POST() {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const db = await getDb();
  const { code, expiresAt } = await mintLinkCode(db, userId);
  return NextResponse.json({ code, expiresAt });
}
