import { NextResponse } from "next/server";
import { getChapter } from "@/lib/books";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; idx: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const { id, idx } = await params;
  const chapter = await getChapter(userId, Number(id), Number(idx));
  if (!chapter) return NextResponse.json({ error: "Chapter not found." }, { status: 404 });
  return NextResponse.json({ chapter });
}
