import { NextResponse } from "next/server";
import { claimAccount } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/claim?code=…` — join the account that minted this code.
 *
 * Two things arrive here. One is the code a reader asked for on a browser they
 * are already signed in on, so a second browser can reach the same library. The
 * other is the code the accounts migration printed to the server log, which is
 * how a library that predates accounts reaches its owner. Both are one-time.
 *
 * A GET that changes something, which is the trade every claim link makes: it
 * has to survive being pasted into an address bar. The code is single-use, so
 * the usual objection — that something will replay it — costs nothing.
 */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const claimed = await claimAccount(code);

  return NextResponse.redirect(new URL(claimed ? "/?claim=ok" : "/?claim=failed", req.url), {
    // 303: the browser must follow this with a GET, and the claim must not be
    // repeated if the reader reloads the page it lands on.
    status: 303,
  });
}
