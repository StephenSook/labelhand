import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";

import {
  extractPdfText,
  PDFJS_VERSION,
  quoteIsPresent,
  readableTextGate,
} from "@/lib/compiler/pdf-text";
import advisoryFixtures from "./fixtures/compiler/in_advisory_section.json";

describe("server PDF text extraction", () => {
  test("uses the pinned pdfjs legacy build and extracts every generated page", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage().drawText("Do not apply when wind speeds exceed 15 mph.", { x: 40, y: 700, font });
    document.addPage().drawText("Apply only when the field check is complete.", { x: 40, y: 700, font });

    const extracted = await extractPdfText(await document.save({ useObjectStreams: false }));

    expect(PDFJS_VERSION).toBe("6.4.299");
    expect(extracted.pageCount).toBe(2);
    expect(extracted.pages[0]).toContain("wind speeds exceed 15 mph");
    expect(extracted.pages[1]).toContain("field check is complete");
    expect(extracted.replacementCharacters).toBe(0);
  });

  test("matches every fixture quote in its bounded page snippet", () => {
    for (const fixture of advisoryFixtures) {
      expect(
        quoteIsPresent(fixture.input.pages[fixture.input.page_no - 1], fixture.input.quote),
        fixture.name,
      ).toBe(true);
    }
  });

  test("refuses long, garbled, and mostly empty labels", () => {
    expect(readableTextGate(Array.from({ length: 41 }, () => "x".repeat(50)))).toMatchObject({ ok: false });
    expect(readableTextGate([`${"\uFFFD".repeat(2)}${"x".repeat(98)}`])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unreadable text layer"),
    });
    expect(readableTextGate(["", "", "x".repeat(50), "x".repeat(50)])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("2 of 4 pages"),
    });
    expect(readableTextGate(["x".repeat(50), "x".repeat(50), "x".repeat(50), ""])).toEqual({ ok: true });
  });
});
