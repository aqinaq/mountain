import { NextResponse } from "next/server";
import { deleteBook, getBook, getChapters } from "@/lib/books";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const id = Number((await params).id);
  const book = await getBook(userId, id);
  if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });
  return NextResponse.json({ book, chapters: await getChapters(userId, id) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const id = Number((await params).id);
  if (!(await getBook(userId, id)))
    return NextResponse.json({ error: "Book not found." }, { status: 404 });
  await deleteBook(userId, id);
  return NextResponse.json({ ok: true });
}
