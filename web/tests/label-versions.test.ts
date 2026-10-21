import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as diffRoute } from "@/app/api/labels/diff/route";
import { GET as versionsRoute } from "@/app/api/labels/versions/[reg]/route";
import { diffLabelVersions, forgetLabelVersionsForTests, labelVersions, VERSIONS_FRESH_MS } from "@/lib/label-versions";
import { PplsError } from "@/lib/ppls";
import freefall from "./fixtures/ppls/product-228-653.json";

const NEWER = "000228-00653-20210514.pdf";
const OLDER = "000228-00653-20210127.pdf";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A real PDF with text on each page, padded past the 20,000 byte floor that tells a PDF from a block page.
async function labelPdf(pages: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) document.addPage().drawText(text, { x: 40, y: 700, font, size: 9 });
  document.setSubject("x".repeat(21_000));
  return document.save({ useObjectStreams: false });
}

function pdfResponse(bytes: Uint8Array): Response {
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200 });
}

beforeEach(() => forgetLabelVersionsForTests());
afterEach(() => vi.unstubAllGlobals());

describe("label versions from EPA PPLS", () => {
  test("lists only this registration's accepted labels, newest first", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(freefall));
    const list = await labelVersions("228-653", fetchMock, () => Date.parse("2026-10-21T15:00:00Z"));

    expect(fetchMock).toHaveBeenCalledWith("https://ordspub.epa.gov/ords/pesticides/cswu/ppls/228-653", expect.anything());
    expect(list.product).toBe("FREEFALL SC COTTON DEFOLIANT");
    // PPLS also lists a 2007 label of an earlier registration (79676-53); it is not a version of this one.
    expect(list.versions.map((v) => v.accepted)).toEqual([
      "2021-05-14", "2021-01-27", "2019-08-23", "2016-04-22", "2012-07-02", "2010-10-19", "2009-12-14", "2009-08-20",
    ]);
    expect(list.versions[0]).toEqual({ fileName: NEWER, accepted: "2021-05-14", url: `https://www3.epa.gov/pesticides/chem_search/ppls/${NEWER}` });
    expect(list.stale).toBeUndefined();
  });

  test("asks PPLS once per six hours, and answers with the last good list when PPLS does not", async () => {
    let now = Date.parse("2026-10-21T15:00:00Z");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(freefall));
    await labelVersions("228-653", fetchMock, () => now);
    await labelVersions("228-653", fetchMock, () => now + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += VERSIONS_FRESH_MS + 1;
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 429 }));
    const stale = await labelVersions("228-653", fetchMock, () => now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale.versions).toHaveLength(8);
    expect(stale.stale?.reason).toContain("HTTP 429");
  });

  test("an outage with nothing remembered is a plain 503 message, and a missing registration stays a 404", async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const outage = await labelVersions("228-653", down).catch((error: unknown) => error);
    expect(outage).toBeInstanceOf(PplsError);
    expect((outage as PplsError).status).toBe(503);
    expect((outage as PplsError).message).toBe(
      "EPA's label system (PPLS) did not answer for EPA Reg. 228-653, so the list of accepted label versions cannot be shown right now. PPLS limits bursts of requests; try again in a few minutes. (EPA label list for 228-653 could not be reached.)",
    );

    const missing = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [] }));
    await expect(labelVersions("1-1", missing)).rejects.toMatchObject({ status: 404 });
    await expect(labelVersions("not-a-reg", missing)).rejects.toMatchObject({ status: 400 });
  });

  test("the versions route caches a fresh list for six hours and never caches an outage", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json(freefall)));
    const ok = await versionsRoute(new Request("http://localhost/api/labels/versions/228-653"), { params: Promise.resolve({ reg: "228-653" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("public, s-maxage=21600, stale-while-revalidate=86400");
    expect((await ok.json() as { versions: unknown[] }).versions).toHaveLength(8);

    forgetLabelVersionsForTests();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")));
    const down = await versionsRoute(new Request("http://localhost/api/labels/versions/228-653"), { params: Promise.resolve({ reg: "228-653" }) });
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store");
    expect((await down.json() as { error: string }).error).toContain("did not answer for EPA Reg. 228-653");
  });
});

describe("comparing two label versions", () => {
  test("reads both PDFs, compares their text and reports each PDF's SHA-256 and page count", async () => {
    const store = "Store in a cool, dry place away from seed, feed and fertilizer.";
    const older = await labelPdf(["Do not apply when wind speeds exceed 10 mph at the application site.", store]);
    const newer = await labelPdf(["Do not apply when wind speeds exceed 15 mph at the application site.", store]);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => pdfResponse(String(input).endsWith(OLDER) ? older : newer));

    const result = await diffLabelVersions("228-653", OLDER, NEWER, fetchMock);

    expect(result.from).toMatchObject({ fileName: OLDER, accepted: "2021-01-27", pages: 2, sha256: createHash("sha256").update(older).digest("hex") });
    expect(result.to).toMatchObject({ fileName: NEWER, accepted: "2021-05-14", pages: 2 });
    expect(result.diff.changes).toHaveLength(1);
    expect(result.diff.changes[0]).toMatchObject({ kind: "changed", conditions: ["wind"], before: { page: 1 }, after: { page: 1 } });

    // The same pair is answered from memory: accepted PDFs never change under their file name.
    await diffLabelVersions("228-653", OLDER, NEWER, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("refuses files of another registration, the same file twice, and a block page served as HTTP 200", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response("<html>Request rejected</html>", { status: 200 }));
    await expect(diffLabelVersions("228-653", "000228-00659-20200131.pdf", NEWER, fetchMock)).rejects.toThrow("does not match registration 228-653");
    await expect(diffLabelVersions("228-653", NEWER, NEWER, fetchMock)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(diffLabelVersions("228-653", OLDER, NEWER, fetchMock)).rejects.toThrow("was only");
  });

  test("the diff route answers with a plain message and no cache when EPA does not serve the PDFs", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")));
    const response = await diffRoute(new NextRequest(`http://localhost/api/labels/diff?reg=228-653&from=${OLDER}&to=${NEWER}`));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as { error: string }).error).toBe("The EPA label PDF for 228-653 could not be reached.");
  });
});
