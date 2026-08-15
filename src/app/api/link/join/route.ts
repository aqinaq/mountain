import { NextResponse } from "next/server";
import { claimAccount } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redeem a link code from inside the app.
 *
 * The same thing `/claim` does, for the reader who is typing the code into the
 * page rather than following a pasted link. Worth having both: `/claim` must
 * work from an address bar, and this must not leave a spent code sitting in the
 * browser's history.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code ?? "").trim();
  if (!code) return NextResponse.json({ error: "Enter the code." }, { status: 400 });

  if (!(await claimAccount(code))) {
    return NextResponse.json(
      { error: "That code was wrong, already used, or too old. Ask for a fresh one." },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
