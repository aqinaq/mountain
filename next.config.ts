import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ships a self-contained server with only the traced dependencies, so the
  // Docker image does not need a node_modules install of its own.
  output: "standalone",

  // pdfjs and jszip are CommonJS-flavoured and only ever run on the server;
  // bundling them into the server chunk breaks their dynamic worker loading.
  serverExternalPackages: ["pdfjs-dist", "jszip", "sanitize-html"],

  // lib/db.ts touches ./data as soon as it is imported, so the tracer decides
  // the reader's own database and uploaded books are build inputs and copies
  // them into .next/standalone. They are runtime state living on a mounted
  // volume — never ship them in a build.
  outputFileTracingExcludes: {
    "/*": ["data/**/*"],
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
