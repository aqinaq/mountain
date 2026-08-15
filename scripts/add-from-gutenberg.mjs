/**
 * Put Gutenberg books on a shelf from the command line.
 *
 *   node --env-file=.env.local scripts/add-from-gutenberg.mjs 1 78105 8868 …
 *
 * The first argument is the account, the rest are Gutenberg ids. Whichever
 * database `TURSO_DATABASE_URL` names is the one that gets them, so without an
 * env file this fills the local `data/reader.db` instead of the live library.
 *
 * This goes through the app's own `importFromGutenberg` rather than writing
 * rows itself: the download, the EPUB parse, the chapter split and the
 * word index all have to happen for a book to be readable, and a second
 * implementation of that here would drift from the one the Add button uses.
 * The import is idempotent per account, so re-running is harmless.
 *
 * Unlike the deployed app, this can ask gutendex for the metadata directly —
 * gutendex refuses a datacentre address, which is why the browser does that
 * lookup in the app, but a laptop is let through.
 */
import { registerHooks } from "node:module";

// Node runs the TypeScript in `src/lib` as-is, but it will not guess at a file
// extension the way tsc does, and every import in there is written `./db`
// rather than `./db.ts`. This puts the extension back on the way past.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      try {
        return next(specifier, context);
      } catch {
        return next(`${specifier}.ts`, context);
      }
    }
    return next(specifier, context);
  },
});

const { importFromGutenberg } = await import("../src/lib/books.ts");
const { mapGutendex } = await import("../src/lib/gutendex.ts");

const [userArg, ...ids] = process.argv.slice(2);
const userId = Number(userArg);

if (!Number.isInteger(userId) || userId <= 0 || ids.length === 0) {
  console.error("Usage: node --env-file=.env.local scripts/add-from-gutenberg.mjs <user-id> <gutenberg-id...>");
  process.exit(1);
}

console.log(`Adding ${ids.length} book(s) to account ${userId} via ${process.env.TURSO_DATABASE_URL ?? "data/reader.db"}\n`);

let failed = 0;

for (const id of ids) {
  const res = await fetch(`https://gutendex.com/books/${encodeURIComponent(id)}`);
  if (!res.ok) {
    console.error(`✗ ${id}: catalogue lookup failed (HTTP ${res.status})`);
    failed++;
    continue;
  }

  const meta = mapGutendex(await res.json());
  process.stdout.write(`  ${meta.title.slice(0, 58)} … `);

  try {
    // One at a time on purpose: these are whole books coming down from
    // gutenberg.org, and a polite queue costs nothing on a run this short.
    const bookId = await importFromGutenberg(userId, meta);
    console.log(`ok (book ${bookId})`);
  } catch (err) {
    console.log(`failed — ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

process.exit(failed > 0 ? 1 : 0);
