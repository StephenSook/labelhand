import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  cacheConfiguredMock,
  compileMock,
  getCachedMock,
  getIndexMock,
  getRegistrationMock,
  writeCacheMock,
} = vi.hoisted(() => ({
  cacheConfiguredMock: vi.fn(),
  compileMock: vi.fn(),
  getCachedMock: vi.fn(),
  getIndexMock: vi.fn(),
  getRegistrationMock: vi.fn(),
  writeCacheMock: vi.fn(),
}));

vi.mock("@/lib/compiler/pipeline", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/compiler/pipeline")>(),
  compileLiveLabel: compileMock,
}));

vi.mock("@/lib/live-cache", () => ({
  getCachedLiveLabel: getCachedMock,
  getLiveCacheIndex: getIndexMock,
  getRegistrationCacheIndex: getRegistrationMock,
  liveCacheConfigured: cacheConfiguredMock,
  writeLiveCache: writeCacheMock,
}));

import { POST } from "@/app/api/labels/compile/route";
import { GET } from "@/app/api/labels/search/route";
import {
  PIPELINE_VERSION,
  PipelineError,
  type CompiledLiveLabel,
  type LiveCompileInput,
  type PipelineEmitter,
  type PipelineEvent,
} from "@/lib/compiler/pipeline";
import { readCompileStream } from "@/lib/compiler/client";
import {
  assertCacheHitAllowed,
  assertColdCompileAllowed,
  CACHE_HITS_PER_WINDOW,
  COLD_COMPILES_PER_WINDOW,
  resetLiveLimitsForTests,
} from "@/lib/live-limits";
import productFixture from "./fixtures/ppls/product-100-1256.json";
import searchFixture from "./fixtures/ppls/search-osprey.json";

const FILE_NAME = "000100-01256-20220503.pdf";
const LABEL_URL = `https://www3.epa.gov/pesticides/chem_search/ppls/${FILE_NAME}`;

function labelBytes(): Uint8Array {
  const bytes = new Uint8Array(20_000);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  return bytes;
}

function compiled(sha256 = "a".repeat(64)): CompiledLiveLabel {
  return {
    reg: "100-1256",
    product: "AXIAL XL",
    label_accepted: "2022-05-03",
    label_sha256: sha256,
    label_url: LABEL_URL,
    label_file: FILE_NAME,
    model: "nvidia/nemotron-3-super-120b-a12b",
    retype_model: "nvidia/Nemotron-3-Ultra-550b-a55b",
    pipeline_version: PIPELINE_VERSION,
    extractor: "pdfjs-6.4.299",
    compiled_utc: "2026-10-19T20:00:00.000Z",
    scored: false,
    restricted_use: false,
    complete: true,
    pages: 1,
    failed_pages: [],
    typing_failures: [],
    tokens_in: 1_000,
    tokens_out: 100,
    total_tokens: 1_100,
    cost_usd: 0.001,
    request_ids: ["req-live"],
    accepted: [],
    rejected: [],
  };
}

function request() {
  return new NextRequest("http://localhost/api/labels/compile", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
    body: JSON.stringify({ reg: "100-1256" }),
  });
}

function pplsResponses(count = 1): Response[] {
  return Array.from({ length: count }, () => [
    new Response(JSON.stringify(productFixture), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(labelBytes().buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "20000" },
    }),
  ]).flat();
}

beforeEach(() => {
  resetLiveLimitsForTests();
  vi.stubEnv("LIVE_COMPILE", "on");
  vi.stubEnv("NEBIUS_API_KEY", "test-key-that-is-never-sent");
  compileMock.mockReset().mockImplementation(async (input: LiveCompileInput, emit: PipelineEmitter) => {
    await emit({ type: "pdf", bytes: input.pdfBytes.byteLength, sha256: input.labelSha256, accepted: input.accepted });
    await emit({ type: "extracted", pages: 1 });
    return compiled(input.labelSha256);
  });
  getCachedMock.mockReset().mockResolvedValue(null);
  getIndexMock.mockReset().mockResolvedValue(null);
  getRegistrationMock.mockReset().mockResolvedValue(null);
  cacheConfiguredMock.mockReset().mockReturnValue(true);
  writeCacheMock.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("label search route", () => {
  test("returns only active federal search results with a one-day CDN cache", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(searchFixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const response = await GET(new NextRequest("http://localhost/api/labels/search?q=osprey"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
    await expect(response.json()).resolves.toMatchObject({
      results: [
        { reg: "264-802", product: "OSPREY HERBICIDE" },
        { reg: "264-1195", product: "Osprey Xtra Herbicide" },
      ],
    });
  });

  test("rejects a search shorter than three characters without fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new NextRequest("http://localhost/api/labels/search?q=ax"));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("label compile route", () => {
  test("streams a cold compile and writes its complete result to cache", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of pplsResponses()) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request());
    const events: PipelineEvent[] = [];
    const result = await readCompileStream(response, (event) => {
      events.push(event);
    });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events.map(({ type }) => type)).toEqual(["listed", "pdf", "extracted", "done"]);
    expect(result.label_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(writeCacheMock).toHaveBeenCalledWith(
      expect.objectContaining({ complete: true }),
      expect.any(AbortSignal),
    );
  });

  test("serves a registration-indexed cache hit without downloading the PDF", async () => {
    const cached = compiled();
    getRegistrationMock.mockResolvedValue({
      reg: cached.reg,
      product: cached.product,
      fileName: cached.label_file,
      accepted: cached.label_accepted,
      labelUrl: cached.label_url,
      sha256: cached.label_sha256,
      pipelineVersion: cached.pipeline_version,
    });
    getCachedMock.mockResolvedValue(cached);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(productFixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const events: PipelineEvent[] = [];
    const result = await readCompileStream(await POST(request()), (event) => {
      events.push(event);
    });
    expect(result).toEqual(cached);
    expect(events.map(({ type }) => type)).toEqual(["listed", "cached"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(compileMock).not.toHaveBeenCalled();
  });

  test("repairs a missing registration pointer discovered through the file index", async () => {
    const cached = compiled();
    getIndexMock.mockResolvedValue({
      reg: cached.reg,
      product: cached.product,
      fileName: cached.label_file,
      accepted: cached.label_accepted,
      labelUrl: cached.label_url,
      sha256: cached.label_sha256,
      pipelineVersion: cached.pipeline_version,
    });
    getCachedMock.mockResolvedValue(cached);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(productFixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(readCompileStream(await POST(request()))).resolves.toEqual(cached);
    expect(writeCacheMock).toHaveBeenCalledWith(cached, expect.any(AbortSignal));
    expect(compileMock).not.toHaveBeenCalled();
  });

  test("serves a registration-indexed cache hit during a PPLS outage", async () => {
    const cached = compiled();
    getRegistrationMock.mockResolvedValue({
      reg: cached.reg,
      product: cached.product,
      fileName: cached.label_file,
      accepted: cached.label_accepted,
      labelUrl: cached.label_url,
      sha256: cached.label_sha256,
      pipelineVersion: cached.pipeline_version,
    });
    getCachedMock.mockResolvedValue(cached);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("PPLS unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const events: PipelineEvent[] = [];
    const result = await readCompileStream(await POST(request()), (event) => {
      events.push(event);
    });
    expect(result).toEqual(cached);
    expect(events.map(({ type }) => type)).toEqual(["listed", "cached"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(compileMock).not.toHaveBeenCalled();
  });

  test("does not serve a registration cache after an authoritative EPA 404", async () => {
    const cached = compiled();
    getRegistrationMock.mockResolvedValue({
      reg: cached.reg,
      product: cached.product,
      fileName: cached.label_file,
      accepted: cached.label_accepted,
      labelUrl: cached.label_url,
      sha256: cached.label_sha256,
      pipelineVersion: cached.pipeline_version,
    });
    getCachedMock.mockResolvedValue(cached);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(readCompileStream(await POST(request()))).rejects.toThrow("did not return registration");
    expect(getCachedMock).not.toHaveBeenCalled();
    expect(compileMock).not.toHaveBeenCalled();
  });

  test("returns 503 before opening a stream when the kill switch is off", async () => {
    vi.stubEnv("LIVE_COMPILE", "off");
    const response = await POST(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("disabled") });
    expect(compileMock).not.toHaveBeenCalled();
  });

  test("rejects an over-limit request before cache or EPA traffic", async () => {
    for (let index = 0; index < CACHE_HITS_PER_WINDOW; index += 1) {
      assertCacheHitAllowed("192.0.2.10");
    }
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getRegistrationMock).not.toHaveBeenCalled();
  });

  test("rejects an exhausted cold quota before EPA traffic", async () => {
    for (let index = 0; index < COLD_COMPILES_PER_WINDOW; index += 1) {
      assertColdCompileAllowed("192.0.2.10");
    }
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(readCompileStream(await POST(request()))).rejects.toThrow("Too many cold label compiles");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("aborts paid compile work when the response reader disconnects", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of pplsResponses()) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    let compileSignal: AbortSignal | undefined;
    compileMock.mockImplementationOnce((input: LiveCompileInput) => {
      compileSignal = input.signal;
      return new Promise<CompiledLiveLabel>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      });
    });
    const response = await POST(request());
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await vi.waitFor(() => expect(compileMock).toHaveBeenCalledTimes(1));
    await reader?.cancel();
    await vi.waitFor(() => expect(compileSignal?.aborted).toBe(true));
  });

  test("reports a configured cache commit failure after a cold compile", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of pplsResponses()) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    writeCacheMock.mockResolvedValue(false);
    await expect(readCompileStream(await POST(request()))).rejects.toThrow("cache record could not be committed");
    expect(compileMock).toHaveBeenCalledTimes(1);
  });

  test("still returns a cold result when Blob is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of pplsResponses()) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    cacheConfiguredMock.mockReturnValue(false);
    writeCacheMock.mockResolvedValue(false);
    await expect(readCompileStream(await POST(request()))).resolves.toMatchObject({ reg: "100-1256" });
    expect(compileMock).toHaveBeenCalledTimes(1);
  });

  test("charges failed pipeline usage to the daily budget", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of pplsResponses(2)) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    compileMock.mockRejectedValueOnce(new PipelineError(
      "Token Factory credit is exhausted.",
      503,
      { inputTokens: 1_000, outputTokens: 1_000, totalTokens: 2_000, costUsd: 2 },
      ["req-billed-failure"],
    ));
    const firstEvents: PipelineEvent[] = [];
    await expect(readCompileStream(await POST(request()), (event) => {
      firstEvents.push(event);
    })).rejects.toThrow("credit is exhausted");
    expect(firstEvents.at(-1)).toMatchObject({ type: "error" });

    const secondEvents: PipelineEvent[] = [];
    await expect(readCompileStream(await POST(request()), (event) => {
      secondEvents.push(event);
    })).rejects.toThrow("daily budget");
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
