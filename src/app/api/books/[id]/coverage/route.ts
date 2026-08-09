import { NextResponse } from "next/server";
import { bookCoverage, indexBook, ownsBook, unknownWords } from "@/lib/words";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const { id } = await params;
  const bookId = Number(id);
  if (!Number.isInteger(bookId) || !(await ownsBook(userId, bookId))) {
    return NextResponse.json({ error: "Unknown book." }, { status: 404 });
  }

  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 50));

  return NextResponse.json({
    coverage: await bookCoverage(userId, bookId),
    unknown: await unknownWords(userId, bookId, limit),
  });
}

/** Re-count the book — used after its text or the word lists have changed. */
export async function POST(_req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const bookId = Number((await params).id);
  if (!Number.isInteger(bookId) || !ownsBook(userId, bookId)) {
    return NextResponse.json({ error: "Unknown book." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...(await indexBook(bookId)) });
}
