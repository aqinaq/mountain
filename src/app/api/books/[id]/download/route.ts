import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getBook, getChapters, getChapter } from "@/lib/books";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function safeName(title: string, ext: string) {
  const base = title.replace(/[^\p{L}\p{N} .-]/gu, "").trim().slice(0, 80) || "book";
  return `${base}.${ext}`;
}

/** Rebuild a plain-text edition when we have no stored original (rare). */
async function asPlainText(userId: number, id: number, title: string, author: string) {
  const lines = [title, author && `by ${author}`, "", ""].filter(Boolean);
  for (const { idx } of await getChapters(userId, id)) {
    const c = await getChapter(userId, id, idx);
    if (!c) continue;
    lines.push(c.title, "");
    lines.push(
      c.html
        .replace(/<\/(p|h[1-6]|li|blockquote|div)>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      "",
    );
  }
  return lines.join("\n");
}

export async function GET(_req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const id = Number((await params).id);
  const book = await getBook(userId, id);
  if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });

  // The stored original, if this book was uploaded rather than fetched. It
  // lives in the database now, so the path traversal this used to guard
  // against is gone with the directory it could have escaped: the row is
  // reached by the book's own id, which ownership has already been checked on.
  const db = await getDb();
  const stored = await db.get<{ ext: string; bytes: Uint8Array }>(
    "SELECT ext, bytes FROM book_files WHERE book_id = ?",
    id,
  );

  if (stored?.bytes) {
    const ext = stored.ext || book.file_ext || "bin";
    const bytes = new Uint8Array(stored.bytes);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type":
          ext === "epub"
            ? "application/epub+zip"
            : ext === "pdf"
              ? "application/pdf"
              : "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName(book.title, ext)}"`,
        "Content-Length": String(bytes.byteLength),
      },
    });
  }

  const text = await asPlainText(userId, id, book.title, book.author);
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName(book.title, "txt")}"`,
    },
  });
}
