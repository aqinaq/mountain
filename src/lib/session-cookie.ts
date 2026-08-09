/**
 * Shared between the proxy, which mints the session cookie, and the session
 * layer, which reads it. Deliberately dependency-free: the proxy runs in front
 * of the app on every request and must not drag the database in with it.
 */

export const SESSION_COOKIE = "mountain_sid";

/** Five years. The cookie *is* the account, so letting it expire loses one. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365 * 5;
