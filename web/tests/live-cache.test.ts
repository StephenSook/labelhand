import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { BlobPreconditionFailedErrorMock, getMock, putMock } = vi.hoisted(() => {
  class MockBlobPreconditionFailedError extends Error {}
  return {
    BlobPreconditionFailedErrorMock: MockBlobPreconditionFailedError,
    getMock: vi.fn(),
    putMock: vi.fn(),
  };
});

vi.mock("@vercel/blob", () => ({
  BlobPreconditionFailedError: BlobPreconditionFailedErrorMock,
  get: getMock,
  put: putMock,
}));

import type { CompiledLiveLabel } from "@/lib/compiler/pipeline";
import {
  compiledCacheKey,
  fileIndexCacheKey,
  getCachedLiveLabel,
  getCachedLiveLabelStrict,
  getLiveCacheIndex,
  getRegistrationCacheIndex,
  getRegistrationCacheIndexStrict,
  registrationIndexCacheKey,
  writeLiveCache,
} from "@/lib/live-cache";

const SHA = "a".repeat(64);
const VERSION = "prompt-p2_typing-v3";

function compiled(): CompiledLiveLabel {
  return {
    reg: "100-1256",
    product: "AXIAL XL",
    label_accepted: "2022-05-03",
    label_sha256: SHA,
    label_url: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
    label_file: "000100-01256-20220503.pdf",
    model: "nvidia/nemotron-3-super-120b-a12b",
    retype_model: "nvidia/Nemotron-3-Ultra-550b-a55b",
    pipeline_version: VERSION,
    extractor: "pdfjs-6.4.299",
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
    request_ids: ["req-1"],
    accepted: [],
    rejected: [],
  };
}

function blobJson(value: unknown) {
  return {
    stream: new Response(JSON.stringify(value)).body,
  };
}

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
  getMock.mockReset();
  putMock.mockReset().mockResolvedValue({});
});

afterEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

describe("live cache", () => {
  test("is a no-op when the Blob token is missing", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(await getCachedLiveLabel(SHA, VERSION)).toBeNull();
    expect(await writeLiveCache(compiled())).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  test("writes the immutable object before its registration and file indexes", async () => {
    expect(await writeLiveCache(compiled())).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(3);
    expect(putMock.mock.calls[0][0]).toBe(compiledCacheKey(SHA, VERSION));
    expect(putMock.mock.calls[0][2]).toMatchObject({ allowOverwrite: false, access: "private" });
    expect(putMock.mock.calls[1][0]).toBe(registrationIndexCacheKey("100-1256"));
    expect(putMock.mock.calls[1][2]).toMatchObject({ allowOverwrite: true, access: "private" });
    expect(putMock.mock.calls[2][0]).toBe(fileIndexCacheKey("000100-01256-20220503.pdf"));
    expect(putMock.mock.calls[2][2]).toMatchObject({ allowOverwrite: true, access: "private" });
  });

  test("repairs the index without replacing an existing compiled object", async () => {
    const conflict = new BlobPreconditionFailedErrorMock("already exists");
    putMock.mockRejectedValueOnce(conflict).mockResolvedValue({});
    expect(await writeLiveCache(compiled())).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(3);
    expect(putMock.mock.calls[1][0]).toBe(registrationIndexCacheKey("100-1256"));
    expect(putMock.mock.calls[2][0]).toBe(fileIndexCacheKey("000100-01256-20220503.pdf"));
  });

  test("requires the registration pointer but tolerates a missing file index", async () => {
    putMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("registration failed"));
    expect(await writeLiveCache(compiled())).toBe(false);
    expect(putMock).toHaveBeenCalledTimes(2);

    putMock.mockReset()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("file index failed"));
    expect(await writeLiveCache(compiled())).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(3);
  });

  test("reads only a complete record matching the requested sha and pipeline", async () => {
    getMock.mockResolvedValue(blobJson(compiled()));
    expect(await getCachedLiveLabel(SHA, VERSION)).toEqual(compiled());
    getMock.mockResolvedValue(blobJson({ ...compiled(), complete: false }));
    expect(await getCachedLiveLabel(SHA, VERSION)).toBeNull();
  });

  test("reads typed file and registration indexes and rejects corrupt shapes", async () => {
    const index = {
      reg: "100-1256",
      product: "AXIAL XL",
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      sha256: SHA,
      pipelineVersion: VERSION,
    };
    getMock
      .mockResolvedValueOnce(blobJson(index))
      .mockResolvedValueOnce(blobJson({ ...index, sha256: "bad" }))
      .mockResolvedValueOnce(blobJson(index))
      .mockResolvedValueOnce(blobJson({ ...index, reg: "100-9999" }));
    expect(await getLiveCacheIndex(index.fileName)).toEqual(index);
    expect(await getLiveCacheIndex(index.fileName)).toBeNull();
    expect(await getRegistrationCacheIndex(index.reg)).toEqual(index);
    expect(await getRegistrationCacheIndex(index.reg)).toBeNull();
  });

  test("strict alert reads distinguish an outage from a missing live compile", async () => {
    getMock.mockRejectedValue(new Error("Blob unavailable"));
    await expect(getRegistrationCacheIndexStrict("100-1256")).rejects.toThrow("Blob unavailable");
    await expect(getCachedLiveLabelStrict(SHA, VERSION)).rejects.toThrow("Blob unavailable");

    getMock.mockResolvedValue(null);
    await expect(getRegistrationCacheIndexStrict("100-1256")).resolves.toBeNull();
    await expect(getCachedLiveLabelStrict(SHA, VERSION)).resolves.toBeNull();
  });
});
