import { NextResponse } from "next/server";
import { importFromGutenberg } from "@/lib/books";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as { gutenbergId?: number };
  const id = Number(body.gutenbergId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A valid Gutenberg book id is required." }, { status: 400 });
  }

  try {
    return NextResponse.json({ id: await importFromGutenberg(userId, id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
