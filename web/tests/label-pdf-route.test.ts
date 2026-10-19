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
    complete: true,
    pages: 20,
    failed_pages: [],
    typing_failures: [],
    tokens_in: 1,
    tokens_out: 1,
    total_tokens: 2,
    cost_usd: 0.01,
    request_ids: ["req-live"],
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
