import { NextResponse } from "next/server";
import { ensureDemoBook } from "@/lib/demo-book";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const userId = await currentUserId();
  if (!userId) return noSession();

  try {
    return NextResponse.json({ id: await ensureDemoBook(userId) });
  } catch {
    return NextResponse.json({ error: "The sample could not be opened. Try again." }, { status: 503 });
  }
}
