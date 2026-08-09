import { NextResponse } from "next/server";
import { getDb, plainAll } from "@/lib/db";
import { lemma } from "@/lib/lemma";
import { backfillCards, dueBreakdown, ensureCards } from "@/lib/srs";
import { currentUserId, noSession } from "@/lib/session";
import { ownsBook } from "@/lib/words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type VocabRow = {
  id: number;
  book_id: number | null;
  book_title: string | null;
  term: string;
  translation: string;
  context: string;
  note: string;
  kind: string;
  lemma: string;
  box: number;
  due_at: number;
  created_at: number;
  /** Aggregated from this entry's cards. */
  card_count: number;
  min_box: number;
};

export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const url = new URL(req.url);
  const bookId = url.searchParams.get("bookId");

  // Entries saved before cards existed still need their card set.
  backfillCards(userId);

  const where: string[] = ["v.user_id = ?"];
  const args: (string | number)[] = [userId];
  if (bookId) {
    where.push("v.book_id = ?");
    args.push(Number(bookId));
  }

  const rows = plainAll(
    getDb()
      .prepare(
        `SELECT v.*,
                b.title AS book_title,
                (SELECT COUNT(*) FROM cards c WHERE c.vocab_id = v.id)            AS card_count,
                COALESCE((SELECT MIN(box) FROM cards c WHERE c.vocab_id = v.id), 1) AS min_box
           FROM vocab v
           LEFT JOIN books b ON b.id = v.book_id
          WHERE ${where.join(" AND ")}
          ORDER BY v.created_at DESC`,
      )
      .all(...args) as VocabRow[],
  );

  const total = (
    getDb().prepare("SELECT COUNT(*) AS n FROM vocab WHERE user_id = ?").get(userId) as { n: number }
  ).n;
  const due = dueBreakdown(userId);

  return NextResponse.json({ items: rows, total, due, dueCount: due.total });
}

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as {
    term?: string;
    translation?: string;
    context?: string;
    note?: string;
    kind?: string;
    bookId?: number | null;
  };

  const term = (body.term ?? "").trim();
  if (!term) return NextResponse.json({ error: "A term is required." }, { status: 400 });

  const kind = body.kind === "phrase" ? "phrase" : "word";
  const base = kind === "word" ? lemma(term) : term.toLowerCase();
  // A word can be saved with no book behind it, and a book id that is not this
  // reader's is treated the same way rather than refused — the word is still
  // worth keeping, it just loses the attribution.
  const claimed = Number.isInteger(body.bookId) ? Number(body.bookId) : null;
  const bookId = claimed !== null && ownsBook(userId, claimed) ? claimed : null;

  getDb()
    .prepare(
      `INSERT INTO vocab (user_id, book_id, term, translation, context, note, kind, lemma, box, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, term, book_id) DO UPDATE SET
         translation = excluded.translation,
         context     = excluded.context,
         lemma       = excluded.lemma`,
    )
    .run(
      userId,
      bookId,
      term,
      (body.translation ?? "").trim(),
      (body.context ?? "").trim().slice(0, 400),
      (body.note ?? "").trim().slice(0, 400),
      kind,
      base,
      Date.now(),
      Date.now(),
    );

  const row = getDb()
    .prepare(
      bookId === null
        ? "SELECT id FROM vocab WHERE user_id = ? AND term = ? AND book_id IS NULL"
        : "SELECT id FROM vocab WHERE user_id = ? AND term = ? AND book_id = ?",
    )
    .get(...(bookId === null ? [userId, term] : [userId, term, bookId])) as { id: number } | undefined;

  if (row) ensureCards(row.id);

  return NextResponse.json({ ok: true, id: row?.id ?? null, lemma: base });
}

export async function DELETE(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "An id is required." }, { status: 400 });
  getDb().prepare("DELETE FROM vocab WHERE id = ? AND user_id = ?").run(id, userId);
  return NextResponse.json({ ok: true });
}
