import { NextResponse } from "next/server";
import { GATE_COOKIE, GATE_MAX_AGE, gateKey, gatePassword, safeNext, sameSecret } from "@/lib/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Take the password from the unlock form and, if it is the right one, let this
 * browser past the gate for a year.
 */
export async function POST(req: Request) {
  const password = gatePassword();
  // No gate configured: there is nothing to unlock, and leaving a form that
  // silently does nothing would be worse than sending them to the library.
  if (!password) return NextResponse.redirect(new URL("/", req.url), { status: 303 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.redirect(new URL("/unlock", req.url), { status: 303 });
  }

  const supplied = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "/"));

  if (!sameSecret(await gateKey(supplied), await gateKey(password))) {
    const retry = new URL("/unlock", req.url);
    retry.searchParams.set("bad", "1");
    if (next !== "/") retry.searchParams.set("next", next);
    return NextResponse.redirect(retry, { status: 303 });
  }

  // 303 so the browser follows with a GET: a reload of the page they land on
  // must not re-post the password.
  const response = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  response.cookies.set({
    name: GATE_COOKIE,
    value: await gateKey(password),
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: GATE_MAX_AGE,
    // Plain HTTP is normal in development and on a machine on your own network.
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
