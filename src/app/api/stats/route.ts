import { NextResponse } from "next/server";
import { getStats } from "@/lib/stats";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return noSession();

  return NextResponse.json(getStats(userId));
}
