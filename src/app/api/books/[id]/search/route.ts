import { NextResponse } from "next/server";
import { searchBook } from "@/lib/words";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const { id } = await params;
  const bookId = Number(id);
  if (!Number.isInteger(bookId)) {
    return NextResponse.json({ error: "Unknown book." }, { status: 404 });
  }

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ hits: [] });

  return NextResponse.json({ hits: searchBook(userId, bookId, q) });
}
