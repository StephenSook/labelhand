import { getDocument, version as pdfjsVersion } from "pdfjs-dist/legacy/build/pdf.mjs";

import { norm, squash } from "./guards";

export const MAX_LABEL_PAGES = 40;
export const NEAR_EMPTY_CHARACTERS = 50;
export const MAX_REPLACEMENT_SHARE = 0.01;
export const PDFJS_VERSION = pdfjsVersion;

export interface ExtractedPdfText {
  pages: string[];
  pageCount: number;
  characters: number;
  replacementCharacters: number;
}

export type ReadableTextResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdfText> {
  const parameters = {
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const loadingTask = getDocument(parameters);
  const document = await loadingTask.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => {
        if (!("str" in item)) return "";
        return `${item.str}${item.hasEOL ? "\n" : ""}`;
      }).join(""));
    }
  } finally {
    await loadingTask.destroy();
  }
  return {
    pages,
    pageCount: pages.length,
    characters: pages.reduce((total, page) => total + page.length, 0),
    replacementCharacters: pages.reduce((total, page) => total + (page.match(/\uFFFD/g)?.length ?? 0), 0),
  };
}

export function readableTextGate(pages: string[]): ReadableTextResult {
  if (pages.length === 0) return { ok: false, reason: "The EPA PDF contained no pages." };
  if (pages.length > MAX_LABEL_PAGES) {
    return { ok: false, reason: `The EPA label has ${pages.length} pages; live compile accepts at most ${MAX_LABEL_PAGES}.` };
  }

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const replacements = page.match(/\uFFFD/g)?.length ?? 0;
    if (replacements / Math.max(1, page.length) > MAX_REPLACEMENT_SHARE) {
      return { ok: false, reason: `Page ${index + 1} has an unreadable text layer; live OCR is not available.` };
    }
  }

  const nearEmpty = pages.filter((page) => page.trim().length < NEAR_EMPTY_CHARACTERS).length;
  if (nearEmpty > pages.length / 4) {
    return { ok: false, reason: `${nearEmpty} of ${pages.length} pages have no readable text layer; live OCR is not available.` };
  }
  return { ok: true };
}

export function quoteIsPresent(pageText: string, quote: string): boolean {
  return squash(norm(pageText)).includes(squash(norm(quote)));
}
