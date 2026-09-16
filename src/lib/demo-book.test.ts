import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dbDir = mkdtempSync(join(tmpdir(), "mountain-demo-"));
process.env.TURSO_DATABASE_URL = `file:${join(dbDir, "demo.db")}`;
delete process.env.TURSO_AUTH_TOKEN;
after(() => rmSync(dbDir, { recursive: true, force: true }));

test("the bundled sample opens once per account with two readable chapters", async () => {
  const { getDb } = await import("./db");
  const { ensureDemoBook } = await import("./demo-book");
  const db = await getDb();

  const now = Date.now();
  const firstUser = (await db.run(
    "INSERT INTO users (created_at, last_seen_at) VALUES (?, ?)", now, now,
  )).lastInsertRowid;
  const secondUser = (await db.run(
    "INSERT INTO users (created_at, last_seen_at) VALUES (?, ?)", now, now,
  )).lastInsertRowid;

  const first = await ensureDemoBook(firstUser);
  assert.equal(await ensureDemoBook(firstUser), first);
  const other = await ensureDemoBook(secondUser);
  assert.notEqual(other, first);

  const books = await db.all<{ id: number; user_id: number; source: string }>(
    "SELECT id, user_id, source FROM books ORDER BY id",
  );
  assert.equal(books.length, 2);
  assert.equal(books[0].source, "demo");
  assert.equal(books[0].user_id, firstUser);

  const chapters = await db.all<{ idx: number; html: string }>(
    "SELECT idx, html FROM chapters WHERE book_id = ? ORDER BY idx", first,
  );
  assert.equal(chapters.length, 2);
  assert.match(chapters[0].html, /ridge was new/);
  assert.match(chapters[1].html, /quiet meadow/);
});
