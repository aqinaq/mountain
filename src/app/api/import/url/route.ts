import { NextResponse } from "next/server";
import { getBook, importFromUrl } from "@/lib/books";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Import a web page as a book: fetch it, pull out the article, store it. */
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as { url?: string };
  const url = (body.url ?? "").trim();
  if (!url) return NextResponse.json({ error: "A web address is required." }, { status: 400 });

  try {
    const id = await importFromUrl(userId, url);
    const book = getBook(userId, id);
    return NextResponse.json({ id, title: book?.title ?? "", chapters: book?.chapter_count ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "That page could not be imported.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
