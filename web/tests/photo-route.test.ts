import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { readLabelPhotoMock, reserveSharedPhotoReadMock } = vi.hoisted(() => ({
  readLabelPhotoMock: vi.fn(),
  reserveSharedPhotoReadMock: vi.fn(),
}));

vi.mock("@/lib/photo-reading", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/photo-reading")>(),
  readLabelPhoto: readLabelPhotoMock,
}));

vi.mock("@/lib/live-ledger", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/live-ledger")>(),
  reserveSharedPhotoRead: reserveSharedPhotoReadMock,
}));

import { POST } from "@/app/api/labels/photo/route";
import { LiveLimitError, PHOTO_READS_PER_WINDOW, assertPhotoReadAllowed, resetLiveLimitsForTests } from "@/lib/live-limits";
import { MAX_PHOTO_BYTES, PhotoReadError } from "@/lib/photo-reading";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const result = {
  verdict: "MATCHED",
  epa_reg_no: "100-1256",
  read_epa_reg_no: "100-1256",
  model_product_name: "Axial XL",
  epa_product_name: "AXIAL XL HERBICIDE",
  alternate_brand_names: [],
  readable: true,
  what_is_visible: "Front panel.",
  name_agrees: true,
  model: "nvidia/Nemotron-3.5-Super-VL",
  latency_ms: 100,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0000012 },
  request_ids: ["req-photo"],
};

function rawRequest(bytes: Uint8Array, contentType = "image/jpeg") {
  return new NextRequest("http://localhost/api/labels/photo", {
    method: "POST",
    headers: { "content-type": contentType, "x-forwarded-for": "192.0.2.10" },
    body: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]),
  });
}

beforeEach(() => {
  resetLiveLimitsForTests();
  vi.stubEnv("LIVE_PHOTO", "on");
  vi.stubEnv("NEBIUS_API_KEY", "test-key-that-is-never-sent");
  readLabelPhotoMock.mockReset().mockResolvedValue(result);
  reserveSharedPhotoReadMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("label photo route", () => {
  test("accepts a raw image and trusts its signature over its declared subtype", async () => {
    const response = await POST(rawRequest(png, "image/jpeg"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reserveSharedPhotoReadMock).toHaveBeenCalledWith(expect.objectContaining({ ip: "192.0.2.10" }));
    expect(readLabelPhotoMock).toHaveBeenCalledWith(
      png,
      "image/png",
      expect.objectContaining({ apiKey: "test-key-that-is-never-sent", signal: expect.any(AbortSignal) }),
    );
    await expect(response.json()).resolves.toMatchObject({ verdict: "MATCHED", epa_reg_no: "100-1256" });
  });

  test("accepts exactly one multipart photo field", async () => {
    const form = new FormData();
    form.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "jug.jpg");
    const request = new NextRequest("http://localhost/api/labels/photo", {
      method: "POST",
      headers: { "x-forwarded-for": "192.0.2.11" },
      body: form,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(readLabelPhotoMock).toHaveBeenCalledWith(jpeg, "image/jpeg", expect.any(Object));
  });

  test("rejects invalid image bytes before reserving shared spend", async () => {
    const response = await POST(rawRequest(new Uint8Array([0x47, 0x49, 0x46])));

    expect(response.status).toBe(415);
    expect(reserveSharedPhotoReadMock).not.toHaveBeenCalled();
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("rejects an image over four MiB with 413", async () => {
    const oversized = new Uint8Array(MAX_PHOTO_BYTES + 1);
    oversized.set(jpeg);
    const response = await POST(rawRequest(oversized));

    expect(response.status).toBe(413);
    expect(reserveSharedPhotoReadMock).not.toHaveBeenCalled();
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("requires a supported request content type", async () => {
    const response = await POST(rawRequest(jpeg, "application/octet-stream"));
    expect(response.status).toBe(415);
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("applies the kill switch before reading the body", async () => {
    vi.stubEnv("LIVE_PHOTO", "off");
    const response = await POST(rawRequest(jpeg));
    expect(response.status).toBe(503);
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("applies the per-instance IP limit before paid work", async () => {
    for (let index = 0; index < PHOTO_READS_PER_WINDOW; index += 1) {
      assertPhotoReadAllowed("192.0.2.10");
    }
    const response = await POST(rawRequest(jpeg));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(reserveSharedPhotoReadMock).not.toHaveBeenCalled();
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("requires configuration before reserving shared spend", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "");
    const response = await POST(rawRequest(jpeg));
    expect(response.status).toBe(503);
    expect(reserveSharedPhotoReadMock).not.toHaveBeenCalled();
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("fails closed when the shared ledger cannot reserve the read", async () => {
    reserveSharedPhotoReadMock.mockRejectedValue(new LiveLimitError("ledger failed", 503));
    const response = await POST(rawRequest(jpeg));
    expect(response.status).toBe(503);
    expect(readLabelPhotoMock).not.toHaveBeenCalled();
  });

  test("preserves actionable Token Factory status and logs billed failure usage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    readLabelPhotoMock.mockRejectedValue(new PhotoReadError(
      "Token Factory credit is exhausted.",
      503,
      { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, costUsd: 0.00039 },
      ["req-billed"],
      { source: "token_factory", upstreamStatus: 402, detail: "Token Factory returned HTTP 402." },
    ));

    const response = await POST(rawRequest(jpeg));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "Token Factory credit is exhausted." });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("req-billed"));
  });
});
