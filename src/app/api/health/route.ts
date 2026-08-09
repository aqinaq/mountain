import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";

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

  try {
    const started = Date.now();
    const client = createClient({ url, authToken: token, intMode: "number" });
    const books = await client.execute("SELECT COUNT(*) AS n FROM books");
    return NextResponse.json({
      ok: true,
      env,
      books: books.rows[0].n,
      roundTripMs: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : String(err), env },
      { status: 503 },
    );
  }
}
