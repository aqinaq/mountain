import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session-cookie";
import { GATE_COOKIE, gateKey, gatePassword, sameSecret } from "@/lib/gate";

/**
 * Hands every visitor a session cookie before the app sees the request.
 *
 * This has to happen out here rather than in a page: a Server Component can
 * read cookies but cannot set them, and the library is a Server Component that
 * needs to know whose library it is on the very first load. So the token is
 * minted in front of the app and written onto both the outgoing response (so
 * the browser keeps it) and the incoming request (so *this* request can already
 * see it).
 *
 * No database here on purpose. The proxy is meant to run ahead of the app,
 * possibly on other infrastructure; the matching account row is created lazily
 * the first time `lib/session.ts` sees a token it does not recognise.
 */
export async function proxy(request: NextRequest) {
  const locked = await lockedOut(request);
  if (locked) return locked;

  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const token = mintToken();

  const headers = new Headers(request.headers);
  const cookie = headers.get("cookie");
  headers.set("cookie", cookie ? `${cookie}; ${SESSION_COOKIE}=${token}` : `${SESSION_COOKIE}=${token}`);

  const response = NextResponse.next({ request: { headers } });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    // Plain HTTP is normal in development and on a machine on your own network.
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}

/**
 * Turn away anyone who does not know the password, or nothing if there is no
 * password to know.
 *
 * This runs before the session cookie is minted on purpose. Minting one for a
 * locked-out request would open an account for every knock at the door, which
 * is the cost the gate exists to avoid.
 */
async function lockedOut(request: NextRequest): Promise<NextResponse | null> {
  const password = gatePassword();
  if (!password) return null;

  // The unlock form is the one thing a locked-out browser has to be able to
  // reach, or there is no way through the gate.
  const { pathname } = request.nextUrl;
  if (pathname === "/unlock" || pathname === "/api/unlock") return null;

  const held = request.cookies.get(GATE_COOKIE)?.value;
  if (held && sameSecret(held, await gateKey(password))) return null;

  // An API call is something the app made, not something a reader navigated
  // to; redirecting it to an HTML form would only produce a confusing parse
  // error wherever the response was awaited.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Locked." }, { status: 401 });
  }

  const unlock = request.nextUrl.clone();
  unlock.pathname = "/unlock";
  unlock.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(unlock);
}

/** 256 bits from the platform CSPRNG, URL-safe so it survives a cookie header. */
function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const config = {
  // Static assets need no session, and minting one for each would set the
  // cookie many times over on a cold load.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icon-192.png|icon-512.png).*)",
  ],
};
