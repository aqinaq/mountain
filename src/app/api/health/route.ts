import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { getDb } from "@/lib/db";
import { listBooks } from "@/lib/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this deployment can actually reach its database, and if not, why.
 *
 * A misconfigured environment variable fails as a 500 with an empty body,
 * which tells whoever is deploying nothing at all. This reports what the
 * process was given — that a variable is present and how long it is, never
 * what it says — and the database's own answer to being asked.
 *
 * Behind the password gate, like everything else under /api.
 */
export async function GET() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  const env = {
    TURSO_DATABASE_URL: url
      ? // The host is safe to show and is the thing most likely to be wrong;
        // a stray quote or a trailing newline shows up here immediately.
        { set: true, value: url, length: url.length }
      : { set: false },
    TURSO_AUTH_TOKEN: token
      ? { set: true, length: token.length, startsWith: token.slice(0, 6) }
      : { set: false },
    MOUNTAIN_PASSWORD: { set: Boolean(process.env.MOUNTAIN_PASSWORD) },
    VERCEL_REGION: process.env.VERCEL_REGION ?? null,
  };

  if (!url) {
    return NextResponse.json({ ok: false, reason: "TURSO_DATABASE_URL is not set", env }, { status: 503 });
  }

  const steps: Record<string, unknown> = {};

  // Each stage separately, because "the database is reachable" and "the app
  // can read a library out of it" fail for different reasons and a single
  // try/catch around both cannot say which one happened.
  try {
    const started = Date.now();
    const client = createClient({ url, authToken: token, intMode: "number" });
    const books = await client.execute("SELECT COUNT(*) AS n FROM books");
    steps.rawQuery = { ok: true, books: books.rows[0].n, ms: Date.now() - started };
  } catch (err) {
    steps.rawQuery = { ok: false, error: describe(err) };
    return NextResponse.json({ ok: false, env, steps }, { status: 503 });
  }

  try {
    const started = Date.now();
    await getDb();
    steps.migrate = { ok: true, ms: Date.now() - started };
  } catch (err) {
    steps.migrate = { ok: false, error: describe(err) };
    return NextResponse.json({ ok: false, env, steps }, { status: 503 });
  }

  try {
    const started = Date.now();
    const books = await listBooks(1);
    steps.listBooks = { ok: true, count: books.length, ms: Date.now() - started };
  } catch (err) {
    steps.listBooks = { ok: false, error: describe(err) };
    return NextResponse.json({ ok: false, env, steps }, { status: 503 });
  }

  return NextResponse.json({ ok: true, env, steps });
}

/** Errors from libSQL carry the useful part in `cause`, not in the message. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` | cause: ${err.cause.message}` : "";
  return `${err.name}: ${err.message}${cause}`;
}
