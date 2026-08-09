/**
 * The shared password that stands in front of the whole app.
 *
 * There is no login here — `lib/session.ts` opens an account for whoever asks,
 * which is exactly right on a machine only you can reach and exactly wrong on
 * a public URL, where it hands every passer-by their own library and a 60 MB
 * upload endpoint pointed at the disk. This gate is what makes exposing the
 * app to the internet survivable: one password, held by the people you gave it
 * to, checked before anything else runs.
 *
 * Shared between `proxy.ts` and the unlock route, so it must stay dependency-
 * free and stick to Web APIs: the proxy runs in front of the app and cannot
 * drag `node:crypto` — or the database — in with it.
 */

export const GATE_COOKIE = "mountain_key";

/** A year. Long enough that a phone kept for reading is not asked twice. */
export const GATE_MAX_AGE = 60 * 60 * 24 * 365;

/** Unset means no gate at all, which is what running on your own machine wants. */
export function gatePassword(): string | undefined {
  return process.env.MOUNTAIN_PASSWORD || undefined;
}

/**
 * What a browser that knows the password is allowed to hold.
 *
 * The password itself never goes in the cookie: this is derived from it, so a
 * cookie lifted off a device cannot be read back into the password that other
 * devices are still using. It is still a bearer token — whoever holds it is
 * through the gate — which is the same bargain the session cookie makes.
 */
export async function gateKey(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`mountain:gate:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare without letting the clock say how much of the secret was right.
 *
 * A plain `===` gives up on the first wrong byte, so the time it takes to fail
 * measures how far a guess got. These are short strings and the app is small,
 * but the whole point of the gate is to be the one thing worth attacking.
 */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return differing === 0;
}

/**
 * Where to send someone after they unlock.
 *
 * Only same-site paths: `next` arrives from the query string, and a URL with a
 * host in it would turn the unlock form into an open redirect — a working
 * password prompt on your domain that lands on somebody else's page.
 */
export function safeNext(candidate: string): string {
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  return candidate;
}
