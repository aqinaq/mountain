/*
 * Offline support for the reader.
 *
 * Two caches with different rules:
 *
 *   shell   — the app's own pages and assets. Network first, so a running dev
 *             server always wins, with the cached copy as the fallback.
 *   content — chapter HTML and the known-word list. Stale-while-revalidate:
 *             a chapter you have already read opens instantly and offline,
 *             and is refreshed in the background when there is a connection.
 *
 * Everything else — translation, progress, vocabulary, uploads — is left alone.
 * Those are writes, or they need a live answer, and a stale one would be worse
 * than an honest failure.
 */

// Bumped when a cached response stops meaning what it used to. v2: chapter text
// and the known-word list became per-account, so anything cached before that
// belongs to nobody in particular and has to go.
const VERSION = "v2";
const SHELL = `mountain-shell-${VERSION}`;
const CONTENT = `mountain-content-${VERSION}`;

const PRECACHE = ["/", "/vocab", "/stats", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // One bad URL must not fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("mountain-") && k !== SHELL && k !== CONTENT)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Chapter text and the known-word list: worth keeping for offline reading. */
function isCacheableContent(url) {
  return (
    /^\/api\/books\/\d+\/chapters\/\d+$/.test(url.pathname) ||
    url.pathname === "/api/known"
  );
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CONTENT);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Refresh in the background; the reader gets the cached copy now.
    network.catch(() => {});
    return cached;
  }

  const response = await network;
  if (response) return response;
  return new Response(JSON.stringify({ error: "You are offline." }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      const cache = await caches.open(SHELL);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.match("/");
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isCacheableContent(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Other API calls need a real answer, not a remembered one.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(networkFirst(request));
});
