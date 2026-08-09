import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session-cookie";

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
export function proxy(request: NextRequest) {
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
