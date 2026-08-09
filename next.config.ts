import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs and jszip are CommonJS-flavoured and only ever run on the server;
  // bundling them into the server chunk breaks their dynamic worker loading.
  serverExternalPackages: ["pdfjs-dist", "jszip", "sanitize-html"],

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
