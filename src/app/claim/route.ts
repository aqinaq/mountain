import { NextResponse } from "next/server";
import { claimAccount } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/claim?code=…` — take ownership of the account the accounts migration left
 * behind, using the one-time code it printed to the server log.
 *
 * A GET that changes something, which is the trade every claim link makes: it
 * has to survive being pasted into an address bar. The code is single-use, so
 * the usual objection — that something will replay it — costs nothing.
 */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const claimed = await claimAccount(code);

  return NextResponse.redirect(new URL(claimed ? "/" : "/?claim=failed", req.url), {
    // 303: the browser must follow this with a GET, and the claim must not be
    // repeated if the reader reloads the page it lands on.
    status: 303,
  });
}
