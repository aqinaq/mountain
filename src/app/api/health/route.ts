import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this deployment can reach its database and load its own modules.
 *
 * Both failures look identical from outside — a 500 with an empty body — and
 * they have nothing to do with each other. A module that throws while being
 * imported takes the whole route down before any handler runs, so nothing here
 * may be imported at the top: every suspect is pulled in inside a try, which
 * is the only way to find out which one is at fault.
 */
export async function GET() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  const env = {
    TURSO_DATABASE_URL: url ? { set: true, value: url } : { set: false },
    TURSO_AUTH_TOKEN: token ? { set: true, length: token.length } : { set: false },
    MOUNTAIN_PASSWORD: { set: Boolean(process.env.MOUNTAIN_PASSWORD) },
    VERCEL_REGION: process.env.VERCEL_REGION ?? null,
  };

  // Third-party first, then this project's modules in dependency order, so the
  // first failure names the deepest thing that is actually broken.
  const suspects: [string, () => Promise<unknown>][] = [
    ["@libsql/client", () => import("@libsql/client")],
    ["jszip", () => import("jszip")],
    ["fast-xml-parser", () => import("fast-xml-parser")],
    ["sanitize-html", () => import("sanitize-html")],
    ["pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs")],
    ["lib/ingest", () => import("@/lib/ingest")],
    ["lib/pdf-layout", () => import("@/lib/pdf-layout")],
    ["lib/words", () => import("@/lib/words")],
    ["lib/books", () => import("@/lib/books")],
  ];

  const imports: Record<string, string> = {};
  for (const [name, load] of suspects) {
    try {
      await load();
      imports[name] = "ok";
    } catch (err) {
      imports[name] = describe(err);
    }
  }

  let database: unknown;
  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM books");
    database = { ok: true, books: row?.n ?? 0 };
  } catch (err) {
    database = { ok: false, error: describe(err) };
  }

  const ok = Object.values(imports).every((v) => v === "ok");
  return NextResponse.json({ ok, env, imports, database }, { status: ok ? 200 : 503 });
}

/** Errors from a failed import carry the useful part in `cause`, not the message. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` | cause: ${err.cause.message}` : "";
  return `${err.name}: ${err.message}${cause}`.slice(0, 400);
}
