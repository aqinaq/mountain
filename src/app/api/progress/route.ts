import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { logReading } from "@/lib/stats";
import { ownsBook } from "@/lib/words";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as {
    bookId?: number;
    chapterIdx?: number;
    scrollPct?: number;
    /** Seconds spent reading since the last heartbeat, for the statistics page. */
    seconds?: number;
  };

  const bookId = Number(body.bookId);
  if (!Number.isInteger(bookId)) {
    return NextResponse.json({ error: "A bookId is required." }, { status: 400 });
  }
  if (!(await ownsBook(userId, bookId))) {
    return NextResponse.json({ error: "Book not found." }, { status: 404 });
  }

  // A heartbeat carries time only. Writing a position it does not have would
  // reset the bookmark to the top of chapter one.
  if (Number.isInteger(body.chapterIdx)) {
    const chapterIdx = Number(body.chapterIdx);
    const scrollPct = Math.min(1, Math.max(0, Number(body.scrollPct) || 0));

    const db = await getDb();
    await db.run(
      `INSERT INTO progress (book_id, chapter_idx, scroll_pct, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET
         chapter_idx = excluded.chapter_idx,
         scroll_pct  = excluded.scroll_pct,
         updated_at  = excluded.updated_at`,
      bookId,
      chapterIdx,
      scrollPct,
      Date.now(),
    );
  }

  if (Number(body.seconds) > 0) await logReading(userId, bookId, Number(body.seconds));

  return NextResponse.json({ ok: true });
}
