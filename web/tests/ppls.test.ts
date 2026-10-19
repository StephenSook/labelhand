import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import {
  fetchLabelPdf,
  listLabelVersions,
  MAX_PDF_BYTES,
  parsePplsFileName,
  searchProducts,
  type PplsLabelVersion,
} from "@/lib/ppls";
import productFixture from "./fixtures/ppls/product-100-1256.json";
import searchFixture from "./fixtures/ppls/search-osprey.json";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("PPLS client", () => {
  test("filters name search to active federal registrations", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(searchFixture));
    const results = await searchProducts("osprey", fetchMock);

    expect(results.map(({ reg }) => reg)).toEqual(["264-802", "264-1195"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ordspub.epa.gov/ords/pesticides/cswu/ProductSearch/partialprodsearch/v2/riname/osprey",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  test("lists matching label versions newest first", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(productFixture));
    const product = await listLabelVersions("100-1256", fetchMock);

    expect(product.product).toBe("AXIAL XL");
    expect(product.versions).toHaveLength(9);
    expect(product.versions[0]).toEqual({
      reg: "100-1256",
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      url: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
    });
  });

  test("preserves an authoritative EPA 404", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(listLabelVersions("100-1256", fetchMock)).rejects.toMatchObject({ status: 404 });
  });

  test("rejects state registrations and mismatched PDF file names", () => {
    expect(() => parsePplsFileName("000100-01256-20220503.pdf", "264-802")).toThrow(/does not match/);
    expect(() => parsePplsFileName("000100-01256-20220503.pdf", "WA060010")).toThrow(/federal EPA/);
  });

  test("downloads only the fixed EPA PDF URL and returns its digest", async () => {
    const bytes = new Uint8Array(20_000);
    bytes.set(new TextEncoder().encode("%PDF-"));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
    }));
    const version: PplsLabelVersion = {
      reg: "100-1256",
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      url: "https://attacker.invalid/ignored.pdf",
    };

    const result = await fetchLabelPdf(version, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(result.byteLength).toBe(20_000);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("refuses non-PDF bodies and declared oversized files", async () => {
    const version: PplsLabelVersion = {
      reg: "100-1256",
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      url: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
    };
    const html = new Uint8Array(20_000);
    html.set(new TextEncoder().encode("<html"));
    await expect(fetchLabelPdf(version, vi.fn<typeof fetch>().mockResolvedValue(new Response(html)))).rejects.toThrow(/not a PDF/);
    await expect(fetchLabelPdf(version, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "content-length": String(MAX_PDF_BYTES + 1) },
    })))).rejects.toThrow(/exceeds/);
  });
});
