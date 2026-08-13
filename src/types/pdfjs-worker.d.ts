/**
 * pdfjs-dist ships types for `pdf.mjs` but not for the worker beside it — the
 * worker is meant to be handed to a `Worker` constructor, not imported. We do
 * import it, to keep pdf.js from loading it by a runtime-built path that no
 * build step can trace (see `loadPdfjs`), and only ever pass the module back to
 * pdf.js untouched, so the shape of it is not ours to describe.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  const worker: unknown;
  export = worker;
}
