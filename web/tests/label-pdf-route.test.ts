import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getCachedMock, getRegistrationMock } = vi.hoisted(() => ({
  getCachedMock: vi.fn(),
  getRegistrationMock: vi.fn(),
}));

vi.mock("@/lib/live-cache", () => ({
  getCachedLiveLabel: getCachedMock,
  getRegistrationCacheIndex: getRegistrationMock,
}));

import { GET } from "@/app/api/label-pdf/[reg]/route";
import type { CompiledLiveLabel } from "@/lib/compiler/pipeline";

const REG = "100-1256";
const FILE_NAME = "000100-01256-20220503.pdf";
const LABEL_URL = `https://www3.epa.gov/pesticides/chem_search/ppls/${FILE_NAME}`;
const PIPELINE_VERSION = "prompt-p2_typing-v3";

function pdfBytes(marker = 0): Uint8Array {
  const bytes = new Uint8Array(20_000);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  bytes[bytes.length - 1] = marker;
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function compiled(sha256: string): CompiledLiveLabel {
  return {
    reg: REG,
    product: "AXIAL XL",
    label_accepted: "2022-05-03",
    label_sha256: sha256,
    label_url: LABEL_URL,
    label_file: FILE_NAME,
    model: "super",
    retype_model: "ultra",
    pipeline_version: PIPELINE_VERSION,
    extractor: "pdfjs-test",
    compiled_utc: "2026-10-19T20:00:00.000Z",
    scored: false,
    restricted_use: false,
    complete: true,
    pages: 20,
    failed_pages: [],
    typing_failures: [],
    tokens_in: 1,
    tokens_out: 1,
    total_tokens: 2,
    cost_usd: 0.01,
    request_ids: ["req-live"],
    readings: 3,
    reading_records: [1, 2, 3].map((reading) => ({
      reading,
      attempts: 1,
      accepted_rules: 0,
      rejected_rules: 0,
      latency_ms: 10,
      tokens_in: 1,
      tokens_out: 1,
      total_tokens: 2,
      cost_usd: 0.01,
      request_ids: [`req-${reading}`],
    })),
    latency_ms: 12,
    merged_from: ["reading-1", "reading-2", "reading-3"],
    accepted: [],
    rejected: [],
  };
}

function index(sha256: string) {
  return {
    reg: REG,
    product: "AXIAL XL",
    fileName: FILE_NAME,
    accepted: "2022-05-03",
    labelUrl: LABEL_URL,
    sha256,
    pipelineVersion: PIPELINE_VERSION,
  };
}

function request() {
  return new Request(`http://localhost/api/label-pdf/${REG}`);
}

function context(reg = REG) {
  return { params: Promise.resolve({ reg }) };
}

beforeEach(() => {
  getCachedMock.mockReset();
  getRegistrationMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("live label PDF route", () => {
  test("serves a cached live registration after verifying its SHA-256", async () => {
    const bytes = pdfBytes();
    const sha256 = digest(bytes);
    getRegistrationMock.mockResolvedValue(index(sha256));
    getCachedMock.mockResolvedValue(compiled(sha256));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody(bytes), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith(LABEL_URL, expect.objectContaining({ cache: "no-store" }));
  });

  test("rejects PDF bytes that do not match the live cache record", async () => {
    const expected = pdfBytes();
    const sha256 = digest(expected);
    getRegistrationMock.mockResolvedValue(index(sha256));
    getCachedMock.mockResolvedValue(compiled(sha256));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody(pdfBytes(1)), { status: 200 })));

    const response = await GET(request(), context());

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain("live cache record");
  });

  test("refuses a cache pointer whose compiled record or fixed URL does not match", async () => {
    const bytes = pdfBytes();
    const sha256 = digest(bytes);
    getRegistrationMock.mockResolvedValue({ ...index(sha256), labelUrl: "https://attacker.invalid/label.pdf" });
    getCachedMock.mockResolvedValue(compiled(sha256));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(getCachedMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("serves an earlier accepted version only as the exact PDF the label comparison read", async () => {
    const bytes = pdfBytes(7);
    const file = "000228-00653-20210127.pdf";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(responseBody(bytes), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const url = (query: string) => new Request(`http://localhost/api/label-pdf/228-653?${query}`);

    const served = await GET(url(`file=${file}&sha256=${digest(bytes)}`), context("228-653"));
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith(`https://www3.epa.gov/pesticides/chem_search/ppls/${file}`, expect.anything());
    expect(getRegistrationMock).not.toHaveBeenCalled();

    const otherBytes = await GET(url(`file=${file}&sha256=${"0".repeat(64)}`), context("228-653"));
    expect(otherBytes.status).toBe(502);
    await expect(otherBytes.text()).resolves.toContain("label comparison");

    fetchMock.mockClear();
    const otherRegistration = await GET(url(`file=000228-00659-20200131.pdf&sha256=${digest(bytes)}`), context("228-653"));
    expect(otherRegistration.status).toBe(400);
    const noDigest = await GET(url(`file=${file}`), context("228-653"));
    expect(noDigest.status).toBe(400);
    const notPpls = await GET(url(`file=..%2F..%2Fsecret.pdf&sha256=${digest(bytes)}`), context("228-653"));
    expect(notPpls.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("limits named versions per address and leaves the shipped label path alone", async () => {
    const bytes = pdfBytes(9);
    const file = "000228-00653-20210127.pdf";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(responseBody(bytes), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const named = () => GET(new Request(`http://localhost/api/label-pdf/228-653?file=${file}&sha256=${digest(bytes)}`, {
      headers: { "x-forwarded-for": "198.51.100.72" },
    }), context("228-653"));
    for (let i = 0; i < 60; i += 1) expect((await named()).status).toBe(200);
    fetchMock.mockClear();
    const limited = await named();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const shipped = await GET(new Request("http://localhost/api/label-pdf/228-653", {
      headers: { "x-forwarded-for": "198.51.100.72" },
    }), context("228-653"));
    expect(shipped.status).not.toBe(429);
  });

  test("refuses a PDF over the size limit, by its declared length and by its body", async () => {
    const file = "000228-00653-20210127.pdf";
    const url = `http://localhost/api/label-pdf/228-653?file=${file}&sha256=${"a".repeat(64)}`;
    const declared = new Response(responseBody(pdfBytes()), { status: 200, headers: { "content-length": String(16 * 1024 * 1024) } });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(declared));
    const byHeader = await GET(new Request(url, { headers: { "x-forwarded-for": "198.51.100.73" } }), context("228-653"));
    expect(byHeader.status).toBe(502);
    await expect(byHeader.text()).resolves.toContain("byte limit");

    const big = new Uint8Array(15 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode("%PDF-1.7\n"));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody(big), { status: 200 })));
    const byBody = await GET(new Request(url, { headers: { "x-forwarded-for": "198.51.100.73" } }), context("228-653"));
    expect(byBody.status).toBe(502);
    await expect(byBody.text()).resolves.toContain("byte limit");
  });

  test("returns 404 when no complete cached live label exists", async () => {
    const bytes = pdfBytes();
    const sha256 = digest(bytes);
    getRegistrationMock.mockResolvedValue(index(sha256));
    getCachedMock.mockResolvedValue(null);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
