import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/labels/compile": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/labels/diff": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/alerts/**/*": [
      "./public/data/compiled/*.ship.json",
      "./public/data/labels/index.json",
      "./public/data/nws_points_cache.json",
      "./src/engine/pkg/labelhand_core_bg.wasm",
    ],
  },
};

export default nextConfig;
