import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { isPublicAddress, publicAddressFor, redirectTarget, safeFetch } from "./safe-fetch";

/**
 * The point of these is the refusals. An importer that will fetch anything is
 * a way to read the private network from outside it, so the cases that matter
 * are the ones where nothing should happen at all.
 */

test("private, loopback and reserved addresses are not public", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // the cloud metadata endpoint, the reason this exists
    "169.254.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1", // loopback wearing an IPv6 costume
    "::ffff:169.254.169.254",
    "2002:a9fe:a9fe::1", // 6to4 wrapping a link-local address
    "64:ff9b::a9fe:a9fe", // NAT64 wrapping the same
  ];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, `${address} should be blocked`);
  }
});

test("ordinary internet addresses are public", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, `${address} should be allowed`);
  }
});

test("anything that is not an address at all is refused", () => {
  for (const value of ["", "localhost", "not-an-ip", "127.0.0.1.", "999.1.1.1", "0x7f000001"]) {
    assert.equal(isPublicAddress(value), false, `${value} should be refused`);
  }
});

test("a hostname that resolves into a private range is refused", async () => {
  await assert.rejects(publicAddressFor("localhost"), /private network/);
  await assert.rejects(publicAddressFor("127.0.0.1"), /private network/);
  await assert.rejects(publicAddressFor("::1"), /private network/);
});

test("non-http addresses are refused before anything is resolved", async () => {
  await assert.rejects(safeFetch("file:///etc/passwd"), /http and https/);
  await assert.rejects(safeFetch("gopher://example.com/"), /http and https/);
  await assert.rejects(safeFetch("nonsense"), /web address/);
});

test("a listening loopback service is never connected to", async () => {
  let reached = false;
  const server = createServer((_req, res) => {
    reached = true;
    res.end("secrets");
  });
  const port = await listen(server);

  try {
    // Every shape the same request can take: by name, by address, and by the
    // IPv6 loopback literal.
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), /private network/);
    await assert.rejects(safeFetch(`http://localhost:${port}/`), /private network/);
    await assert.rejects(safeFetch(`http://[::1]:${port}/`), /private network/);
    assert.equal(reached, false, "the server should not have been contacted at all");
  } finally {
    server.close();
  }
});

test("a redirect is resolved, and only to something still fetchable", () => {
  const from = new URL("https://example.com/a/b");

  assert.equal(redirectTarget("/c", from).toString(), "https://example.com/c");
  assert.equal(redirectTarget("c", from).toString(), "https://example.com/a/c");
  assert.equal(redirectTarget("//other.example/c", from).toString(), "https://other.example/c");
  assert.equal(redirectTarget("http://other.example/", from).toString(), "http://other.example/");

  for (const bad of ["file:///etc/passwd", "gopher://example.com/", "data:text/html,hi"]) {
    assert.throws(() => redirectTarget(bad, from), /cannot be fetched/);
  }

  // Allowed through as a URL and then refused on its address by the loop, which
  // is why every hop is resolved rather than only the first.
  const internal = redirectTarget("http://169.254.169.254/", from);
  assert.equal(isPublicAddress(internal.hostname), false);
});

test("the metadata endpoint is refused", async () => {
  await assert.rejects(
    safeFetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
    /private network/,
  );
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}
