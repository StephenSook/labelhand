import { describe, expect, test, vi } from "vitest";

import { TokenFactoryError, type TokenUsage } from "@/lib/compiler/token-factory";
import {
  detectPhotoMime,
  PHOTO_MAX_TOKENS,
  PHOTO_MODEL,
  PhotoReadError,
  productNamesAgree,
  productNameTokens,
  readLabelPhoto,
  validatePhotoModelReading,
  verifyPhotoReading,
  type PhotoModelReading,
} from "@/lib/photo-reading";
import { PplsError, type PplsProduct } from "@/lib/ppls";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const usage: TokenUsage = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, costUsd: 0.00039 };
const measurement = { usage, latencyMs: 123, requestIds: ["req-test"] };

function reading(overrides: Partial<PhotoModelReading> = {}): PhotoModelReading {
  return {
    epa_reg_no: "100-1256",
    product_name: "Axial XL",
    readable: true,
    what_is_visible: "Front panel with the product name and EPA registration number.",
    ...overrides,
  };
}

function product(overrides: Partial<PplsProduct> = {}): PplsProduct {
  return {
    reg: "100-1256",
    product: "AXIAL XL HERBICIDE",
    status: "Active",
    statusDate: "",
    cancelled: false,
    cancellationReason: "",
    alternateBrandNames: [],
    versions: [{
      reg: "100-1256",
      fileName: "000100-01256-20250101.pdf",
      accepted: "2025-01-01",
      url: "https://example.test/label.pdf",
    }],
    ...overrides,
  };
}

function completion(value: unknown, requestId = "req-photo"): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": requestId } });
}

describe("photo reading primitives", () => {
  test("detects JPEG and PNG from signatures rather than headers", () => {
    expect(detectPhotoMime(jpeg)).toBe("image/jpeg");
    expect(detectPhotoMime(png)).toBe("image/png");
    expect(detectPhotoMime(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull();
  });

  test("requires the exact model response fields", () => {
    expect(validatePhotoModelReading(reading())).toEqual(reading());
    expect(() => validatePhotoModelReading({ ...reading(), confidence: 0.99 })).toThrow(TokenFactoryError);
    expect(() => validatePhotoModelReading({ ...reading(), readable: "yes" })).toThrow(TokenFactoryError);
  });

  test("normalizes punctuation and joined letter-number product names", () => {
    expect(productNameTokens("Fólex 6 EC, cotton defoliant")).toEqual(["folex", "6", "ec"]);
    expect(productNamesAgree("ASSAIL 30SG", ["ASSAIL 30 SG INSECTICIDE"])).toBe(true);
    expect(productNamesAgree("Warrant", ["MON 63410", "WARRANT HERBICIDE"])).toBe(true);
    expect(productNamesAgree("Prep", ["PREP BRAND ETHEPHON FOR COTTON AND TOBACCO"])).toBe(true);
    expect(productNamesAgree("Prep", ["PREP™brand Ethephon FOR COTTON AND TOBACCO"])).toBe(true);
    expect(productNamesAgree("AIM EC", ["AIM EC HERBICIDE"])).toBe(true);
    expect(productNamesAgree("2,4-D", ["2,4-D"])).toBe(true);
    expect(productNamesAgree("Vantacor", ["VANTACOR insect control"])).toBe(true);
    expect(productNamesAgree("Warrior II", ["WARRIOR II WITH ZEON TECHNOLOGY"])).toBe(true);
    expect(productNamesAgree("Priaxor", ["Priaxor Xemium Brand Fungicide"])).toBe(true);
    expect(productNamesAgree("Abound", ["ABOUND FLOWABLE FUNGICIDE"])).toBe(true);
    expect(productNamesAgree("Osprey", ["Osprey Xtra Herbicide"])).toBe(false);
    expect(productNamesAgree("Osprey Xtra", ["Osprey Xtra Herbicide"])).toBe(true);
    expect(productNamesAgree("Herbicide", ["AXIAL XL HERBICIDE"])).toBe(false);
  });
});

describe("deterministic EPA verification", () => {
  test("returns MATCHED for an EPA registration and agreeing canonical name", async () => {
    await expect(verifyPhotoReading(reading(), measurement, async () => product())).resolves.toMatchObject({
      verdict: "MATCHED",
      epa_reg_no: "100-1256",
      read_epa_reg_no: "100-1256",
      model_product_name: "Axial XL",
      epa_product_name: "AXIAL XL HERBICIDE",
      name_agrees: true,
    });
  });

  test("accepts an agreeing alternate brand name", async () => {
    const result = await verifyPhotoReading(
      reading({ epa_reg_no: "524-591", product_name: "Warrant" }),
      measurement,
      async () => product({ reg: "524-591", product: "MON 63410", alternateBrandNames: ["WARRANT HERBICIDE"] }),
    );
    expect(result).toMatchObject({ verdict: "MATCHED", epa_reg_no: "524-591", name_agrees: true });
  });

  test("returns both names when the EPA registration exists but the name differs", async () => {
    const result = await verifyPhotoReading(
      reading({ product_name: "Different Product" }),
      measurement,
      async () => product(),
    );
    expect(result).toMatchObject({
      verdict: "NAME_DIFFERS",
      epa_reg_no: "100-1256",
      model_product_name: "Different Product",
      epa_product_name: "AXIAL XL HERBICIDE",
      name_agrees: false,
    });
  });

  test("does not query EPA for unreadable or malformed registrations", async () => {
    const lookup = vi.fn(async () => product());
    await expect(verifyPhotoReading(reading({ readable: false }), measurement, lookup)).resolves.toMatchObject({ verdict: "UNREADABLE", epa_reg_no: null });
    await expect(verifyPhotoReading(reading({ epa_reg_no: "100-12O6" }), measurement, lookup)).resolves.toMatchObject({ verdict: "UNREADABLE", epa_reg_no: null });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("distinguishes a missing registration from an EPA outage", async () => {
    await expect(verifyPhotoReading(reading(), measurement, async () => {
      throw new PplsError("missing", 404);
    })).resolves.toMatchObject({ verdict: "NOT_FOUND", epa_reg_no: null, read_epa_reg_no: "100-1256" });
    await expect(verifyPhotoReading(reading(), measurement, async () => {
      throw new PplsError("unavailable", 502);
    })).rejects.toMatchObject({ status: 502 });
  });
});

describe("live vision request", () => {
  test("sends the image as a data URL with strict schema and deterministic settings", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion(reading()));
    const result = await readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      lookupProduct: async () => product(),
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    const messages = body.messages as Array<{ content: unknown }>;
    const userContent = messages[1]?.content as Array<Record<string, unknown>>;

    expect(body).toMatchObject({
      model: PHOTO_MODEL,
      temperature: 0,
      max_tokens: PHOTO_MAX_TOKENS,
      response_format: { type: "json_schema", json_schema: { name: "label_photo_read", strict: true } },
    });
    expect(userContent[0]).toMatchObject({
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) },
    });
    expect(result).toMatchObject({ verdict: "MATCHED", request_ids: ["req-photo"] });
    expect(result.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 });
    expect(result.usage.costUsd).toBeCloseTo(0.00039);
  });

  test("rejects a declared type that does not match the bytes", async () => {
    await expect(readLabelPhoto(png, "image/jpeg", {
      apiKey: "test-key",
      lookupProduct: async () => product(),
    })).rejects.toThrow(/signature/);
  });

  test("records every billed attempt when malformed JSON is retried", async () => {
    const malformed = new Response(JSON.stringify({
      choices: [{ message: { content: "{" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
    }), { status: 200, headers: { "x-request-id": "req-bad" } });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(completion(reading(), "req-good"));
    const result = await readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      lookupProduct: async () => product(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.request_ids).toEqual(["req-bad", "req-good"]);
    expect(result.usage).toMatchObject({ inputTokens: 2_000, outputTokens: 200, totalTokens: 2_200 });
    expect(result.usage.costUsd).toBeCloseTo(0.00078);
  });

  test("preserves a billed truncated response as an actionable error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion(reading(), "req-long"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(reading()) }, finish_reason: "length" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 320, total_tokens: 1_320 },
    }), { status: 200, headers: { "x-request-id": "req-long" } }));
    await expect(readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      lookupProduct: async () => product(),
    })).rejects.toMatchObject({
      status: 502,
      message: "Token Factory reached the label photo response limit.",
      usage: { inputTokens: 1_000, outputTokens: 320, totalTokens: 1_320 },
      requestIds: ["req-long"],
      diagnostic: { source: "token_factory", detail: "Token Factory response reached max_tokens." },
    });
  });

  test("preserves usage and request IDs when all billed responses are malformed", async () => {
    const malformed = () => new Response(JSON.stringify({
      choices: [{ message: { content: "{" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
    }), { status: 200, headers: { "x-request-id": "req-billed" } });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(malformed())
      .mockResolvedValueOnce(malformed())
      .mockResolvedValueOnce(malformed());

    const caught = await readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      lookupProduct: async () => product(),
    }).then(() => null, (error: unknown) => error);

    expect(caught).toBeInstanceOf(PhotoReadError);
    expect(caught).toMatchObject({
      status: 502,
      usage: { inputTokens: 3_000, outputTokens: 300, totalTokens: 3_300 },
      requestIds: ["req-billed", "req-billed", "req-billed"],
      diagnostic: { source: "token_factory", detail: expect.stringContaining("SyntaxError") },
    });
    expect((caught as PhotoReadError).usage.costUsd).toBeCloseTo(0.00117);
  });

  test("maps Token Factory credit exhaustion to an actionable status", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("payment required", { status: 402 }));
    await expect(readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      lookupProduct: async () => product(),
    })).rejects.toMatchObject({
      status: 503,
      message: "Token Factory credit is exhausted.",
      usage: { totalTokens: 0, costUsd: 0 },
      diagnostic: { source: "token_factory", upstreamStatus: 402 },
    });
  });

  test.each([
    [400, 502, "Token Factory rejected the label photo request."],
    [401, 503, "Token Factory credentials are unavailable."],
    [403, 503, "Token Factory credentials are unavailable."],
    [429, 429, "Token Factory is busy. Try again shortly."],
  ])("maps upstream HTTP %s without losing its diagnostic", async (upstreamStatus, status, message) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response("failure", { status: upstreamStatus }));
    await expect(readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      lookupProduct: async () => product(),
    })).rejects.toMatchObject({
      status,
      message,
      diagnostic: {
        source: "token_factory",
        upstreamStatus,
        detail: expect.stringContaining(`HTTP ${upstreamStatus}`),
      },
    });
  });

  test("preserves billed usage when EPA verification fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion(reading()));
    await expect(readLabelPhoto(jpeg, "image/jpeg", {
      apiKey: "test-key",
      tokenFactoryFetch: fetchMock,
      lookupProduct: async () => {
        throw new PplsError("EPA unavailable", 502);
      },
    })).rejects.toMatchObject({
      status: 502,
      message: "EPA unavailable",
      usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
      requestIds: ["req-photo"],
      diagnostic: { source: "ppls", upstreamStatus: 502, detail: "EPA unavailable" },
    });
  });
});
