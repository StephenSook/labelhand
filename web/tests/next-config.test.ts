import { describe, expect, test } from "vitest";

import nextConfig from "../next.config";

describe("Next server configuration", () => {
  test("traces the pdfjs Node worker used by live compilation", () => {
    expect(nextConfig.outputFileTracingIncludes?.["/api/labels/compile"]).toContain(
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    );
  });
});
