import { lookup as resolveHost } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Fetching a URL the reader chose, from inside the deployment.
 *
 * A server that will fetch any address it is handed is a server that will read
 * the private network on a stranger's behalf: the cloud metadata endpoint at
 * 169.254.169.254 hands out credentials to anything that asks, and every
 * internal service on 10.x is reachable from the same place this code runs.
 * That is server-side request forgery, and `fetch` on its own does nothing
 * about it.
 *
 * Three things are needed, and the third is the one usually missed:
 *
 *  1. Resolve the hostname and refuse every private, loopback, link-local and
 *     otherwise reserved address it answers with.
 *  2. Re-do that check on every redirect, because a public URL is free to
 *     redirect to http://127.0.0.1:6379 and `redirect: "follow"` would take it.
 *  3. Connect to the address that was actually checked. A name checked and then
 *     handed back to the network stack is resolved a second time, and a DNS
 *     record with a one-second TTL can answer differently the second time — the
 *     rebinding attack. So the request is made with a `lookup` that returns the
 *     verified address and nothing else.
 *
 * That last point is why this is built on `node:https` rather than `fetch`:
 * `fetch` does its own resolving and will not be told where to connect. The
 * cost is that redirects, the byte cap and the timeout are all by hand, which
 * is the bulk of what follows. Compression is not, because a request that does
 * not advertise `Accept-Encoding` is answered with plain bytes.
 */

/**
 * Everything that is not the public internet.
 *
 * Erring towards refusal: the reserved and documentation ranges are no use to
 * a reader either way, so blocking them costs nothing and saves arguing about
 * which of them some host might route internally.
 */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — cloud metadata lives here
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64, which embeds an IPv4 address
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/**
 * Whether an address is one we are willing to open a socket to.
 *
 * IPv4-mapped forms (`::ffff:127.0.0.1`) are handled by `BlockList` itself,
 * which is the reason this uses it rather than comparing integers by hand:
 * that mapping is exactly where a hand-rolled check tends to let loopback
 * through.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !PRIVATE.check(address, family === 6 ? "ipv6" : "ipv4");
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} is on a private network, so it cannot be fetched.`);
    this.name = "BlockedAddressError";
  }
}

/**
 * The addresses a hostname answers with, once we are satisfied with all of
 * them.
 *
 * All of them, not the first: a name that resolves to one public address and
 * one loopback address is not a name with a usable address, it is a name
 * built to get past a check that only looks at the front of the list.
 */
export async function publicAddressFor(hostname: string): Promise<{ address: string; family: number }> {
  // A literal address in the URL never reaches a resolver, so it is checked here.
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new BlockedAddressError(hostname);
    return { address: hostname, family: isIP(hostname) };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await resolveHost(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`${hostname} could not be found.`);
  }
  if (!answers.length) throw new Error(`${hostname} could not be found.`);
  for (const { address } of answers) {
    if (!isPublicAddress(address)) throw new BlockedAddressError(hostname);
  }
  return answers[0];
}

/**
 * The host as an address or a name, without the brackets a URL puts round an
 * IPv6 literal. `new URL("http://[::1]/").hostname` is the string `[::1]`,
 * which is neither a valid address to classify nor a name that resolves — so
 * left alone it turns an address check into a failed DNS lookup.
 */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export type SafeResponse = {
  /** The address the body actually came from, after any redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
};

export type SafeFetchOptions = {
  /** Refuse a body larger than this, mid-download rather than after it. */
  maxBytes?: number;
  /** Wall clock for the whole thing, redirects included. */
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  userAgent?: string;
};

const DEFAULT_UA = "Mozilla/5.0 (compatible; MountainReader/1.0)";

export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const {
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 20_000,
    maxRedirects = 5,
    accept = "*/*",
    userAgent = DEFAULT_UA,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let url = parseHttpUrl(input);

  for (let hop = 0; ; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError();

    const { address, family } = await publicAddressFor(bareHostname(url));
    const res = await send(url, { address, family, accept, userAgent, timeoutMs: remaining });

    const location = res.headers.location;
    if (location && res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
      res.resume(); // let the socket go; we are not reading this body
      if (hop >= maxRedirects) throw new Error("That address redirects too many times.");
      url = redirectTarget(location, url);
      continue; // and round again — including the address check, which is the point
    }

    const body = await collect(res, maxBytes, deadline);
    return {
      url: url.toString(),
      status: res.statusCode ?? 0,
      contentType: res.headers["content-type"] ?? "",
      body,
    };
  }
}

/** The text of a response, honouring the charset the server declared. */
export function decodeBody(res: SafeResponse): string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(res.contentType)?.[1];
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset).decode(res.body);
    } catch {
      /* an encoding this build does not know — fall through to UTF-8 */
    }
  }
  return res.body.toString("utf8");
}

export class TimeoutError extends Error {
  constructor() {
    super("That page took too long to respond.");
    this.name = "TimeoutError";
  }
}

/**
 * Where a `Location` header points, which is only ever a URL we are still
 * willing to ask for. It may be relative, and it may be a scheme we do not
 * speak — `location: file:///etc/passwd` is a redirect a server is free to
 * send and one we are not free to follow.
 *
 * That the address behind it is public is not settled here: it is settled by
 * the loop, which resolves and checks every hop before opening a socket.
 */
export function redirectTarget(location: string, from: URL): URL {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new Error("That address redirects somewhere that cannot be fetched.");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new Error("That address redirects somewhere that cannot be fetched.");
  }
  return next;
}

function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("That does not look like a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https addresses can be fetched.");
  }
  return url;
}

/** One request, to one address that has already been vetted. */
function send(
  url: URL,
  opts: { address: string; family: number; accept: string; userAgent: string; timeoutMs: number },
): Promise<IncomingMessage> {
  const https = url.protocol === "https:";
  const request = https ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        // `hostname` is kept as the name, not the address, so the Host header,
        // TLS SNI and certificate check all still refer to the site itself.
        // Only where the socket goes is overridden.
        hostname: bareHostname(url),
        port: url.port || (https ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "User-Agent": opts.userAgent,
          Accept: opts.accept,
          "Accept-Language": "en;q=0.9,*;q=0.5",
          Host: url.host,
        },
        lookup: pinned(opts.address, opts.family),
        timeout: opts.timeoutMs,
      },
      resolve,
    );

    req.on("timeout", () => req.destroy(new TimeoutError()));
    req.on("error", (err) =>
      reject(
        err instanceof TimeoutError || err instanceof BlockedAddressError
          ? err
          : new Error(`${bareHostname(url)} could not be reached.`),
      ),
    );
    req.end();
  });
}

/** A resolver that has already made up its mind. */
function pinned(address: string, family: number) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      addressOrList: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function collect(res: IncomingMessage, maxBytes: number, deadline: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      reject(tooBig(maxBytes));
      return;
    }

    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        reject(tooBig(maxBytes));
        return;
      }
      if (Date.now() > deadline) {
        res.destroy();
        reject(new TimeoutError());
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", (err) => reject(err instanceof TimeoutError ? err : new Error("That download was interrupted.")));
  });
}

function tooBig(maxBytes: number): Error {
  return new Error(`That file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
}
