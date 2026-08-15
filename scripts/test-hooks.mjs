import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Let `node --test` resolve the app's own imports.
 *
 * The source is written for the bundler: `./ingest` with no extension, and
 * `@/lib/db` for the alias in tsconfig. Node's ESM resolver does neither, so
 * without this the tests can only import files that import nothing. The hook
 * covers the two shapes the app actually uses and hands everything else back
 * unchanged — it is a test-time convenience, not a second resolver to maintain.
 */

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx", ".js", ".mjs"];

function firstThatExists(base) {
  if (existsSync(base) && !existsSync(`${base}/`)) return base;
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith(".");
    const aliased = specifier.startsWith("@/");
    if (!relative && !aliased) return nextResolve(specifier, context);

    const base = aliased
      ? resolvePath(ROOT, "src", specifier.slice(2))
      : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);

    const found = firstThatExists(base);
    if (!found) return nextResolve(specifier, context);
    return { url: pathToFileURL(found).href, shortCircuit: true };
  },
});
