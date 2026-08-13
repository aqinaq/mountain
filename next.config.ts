import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs and jszip are CommonJS-flavoured and only ever run on the server;
  // bundling them into the server chunk breaks their dynamic worker loading.
  //
  // sanitize-html is deliberately not in this list. It has no worker to break,
  // and being external is what forces it to be require()d at runtime — which
  // fails, because the htmlparser2 it reaches for is now ESM-only. Bundled, the
  // build resolves that itself and the question never arises.
  serverExternalPackages: ["pdfjs-dist", "jszip"],

  // pdf.js loads its worker by a path it assembles at runtime, so nothing in
  // the build sees that this file is needed and it is left out of the deployed
  // bundle. `loadPdfjs` imports it by a name the trace can follow, which should
  // be enough on its own; this says so outright as well, because the failure it
  // guards against only appears in a deployment. Upload is the only route that
  // reads a PDF, and health is the one that checks it still can — the file is
  // 2.4 MB, so nothing else carries it.
  outputFileTracingIncludes: {
    "/api/upload": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/health": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },

  async headers() {
    return [
      {
        // A cached service worker can never be replaced, so this one file must
        // always be fetched fresh.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
