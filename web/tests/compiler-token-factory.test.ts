import { describe, expect, test, vi } from "vitest";

import {
  callStrictJson,
  compilePage,
  FIRST_PASS_MODEL,
  MAX_ATTEMPTS,
  TokenFactoryError,
  UPSTREAM_TIMEOUT_MS,
} from "@/lib/compiler/token-factory";
import {
  applyTyping,
  hasTopicWord,
  TYPING_MODEL,
  typeRule,
  vote,
  type CompilerRule,
  type TypedAnswer,
} from "@/lib/compiler/typing";
import voteFixtures from "./fixtures/compiler/vote.json";

function completion(content: unknown, options: { status?: number; finishReason?: string; requestId?: string } = {}): Response {
  const status = options.status ?? 200;
  return new Response(status === 200 ? JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason: options.finishReason ?? "stop" }],
    usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
  }) : "failure", {
    status,
    headers: { "content-type": "application/json", "x-request-id": options.requestId ?? "req-test" },
  });
}

const options = (fetchImpl: typeof fetch) => ({
  apiKey: "test-key-that-is-never-sent",
  fetchImpl,
  sleep: vi.fn(async () => undefined),
});

function rule(overrides: Partial<CompilerRule> = {}): CompilerRule {
  return {
    id: "100-1256-p1-1",
    page: 1,
    quote: "Do not apply when wind speeds exceed 15 mph.",
    summary: "wind limit",
    param: "wind_speed_mph",
    op: "gt",
    value: 15,
    value2: null,
    unit: "mph",
    modality: "MUST_NOT",
    ...overrides,
  };
}

describe("Token Factory compiler client", () => {
  test("sends a strict Super request and records usage and request ID", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion({ rules: [] }, { requestId: "req-super" }));
    const result = await compilePage(2, "page text", options(fetchMock));
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(request).toMatchObject({
      model: FIRST_PASS_MODEL,
      max_tokens: 6_000,
      response_format: { type: "json_schema", json_schema: { strict: true } },
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(UPSTREAM_TIMEOUT_MS).toBe(60_000);
    expect(result.requestIds).toEqual(["req-super"]);
    expect(result.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 });
    expect(result.usage.costUsd).toBeCloseTo(0.00039);
  });

  test("splits a truncated page instead of retrying it unchanged", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({}, { finishReason: "length", requestId: "req-full" }))
      .mockResolvedValueOnce(completion({ rules: [{ quote: "first" }] }, { requestId: "req-a" }))
      .mockResolvedValueOnce(completion({ rules: [{ quote: "second" }] }, { requestId: "req-b" }));
    const result = await compilePage(3, "first line\nsecond line", options(fetchMock));

    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(2);
    expect(result.requestIds).toEqual(["req-full", "req-a", "req-b"]);
    expect(result.splits).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test.each([400, 401, 402, 403])("does not retry HTTP %s", async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion({}, { status }));
    await expect(callStrictJson({
      model: FIRST_PASS_MODEL,
      system: "system",
      user: "user",
      schemaName: "test",
      schema: {},
      maxTokens: 10,
    }, options(fetchMock))).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries retryable responses up to three attempts", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({}, { status: 429 }))
      .mockResolvedValueOnce(completion({}, { status: 500 }))
      .mockResolvedValueOnce(completion({ ok: true }));
    const result = await callStrictJson<{ ok: boolean }>({
      model: FIRST_PASS_MODEL,
      system: "system",
      user: "user",
      schemaName: "test",
      schema: {},
      maxTokens: 10,
    }, options(fetchMock));
    expect(result.value.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  test("counts usage from a billed malformed attempt before retrying", async () => {
    const malformed = new Response(JSON.stringify({
      choices: [{ message: { content: "{" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
    }), { status: 200, headers: { "x-request-id": "req-malformed" } });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(completion({ ok: true }, { requestId: "req-good" }));
    const observed: Array<{ total: number; requestId: string | null }> = [];
    const result = await callStrictJson<{ ok: boolean }>({
      model: FIRST_PASS_MODEL,
      system: "system",
      user: "user",
      schemaName: "test",
      schema: {},
      maxTokens: 10,
    }, {
      ...options(fetchMock),
      onUsage: (usage, requestId) => observed.push({ total: usage.totalTokens, requestId }),
    });
    expect(result.value.ok).toBe(true);
    expect(observed).toEqual([
      { total: 1_100, requestId: "req-malformed" },
      { total: 1_100, requestId: "req-good" },
    ]);
  });

  test("does not start or retry a request after parent cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("compile deadline"));
    const fetchMock = vi.fn<typeof fetch>();
    await expect(callStrictJson({
      model: FIRST_PASS_MODEL,
      system: "system",
      user: "user",
      schemaName: "test",
      schema: {},
      maxTokens: 10,
    }, { ...options(fetchMock), signal: controller.signal })).rejects.toThrow("compile deadline");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses Ultra only for topic-word typing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion({
      param: "wind_speed_mph",
      op: "gt",
      value: 15,
      value2: null,
      unit: "mph",
      modality: "MUST_NOT",
    }));
    expect(hasTopicWord(rule())).toBe(true);
    expect(hasTopicWord(rule({ quote: "Wear protective gloves." }))).toBe(false);
    const result = await typeRule(rule(), options(fetchMock));
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(request.model).toBe(TYPING_MODEL);
    expect(String(request.model)).not.toContain("Lightning");
  });

  test.each(voteFixtures)("matches Python vote for $name", ({ input, expected }) => {
    expect(vote(input.first_pass_param, input.typed as TypedAnswer[])).toEqual(expected);
  });

  test("keeps the guarded first pass when typing invents a number", () => {
    const first = rule();
    const typed: TypedAnswer = {
      param: "wind_speed_mph",
      op: "gt",
      value: 12,
      value2: null,
      unit: "mph",
      modality: "MUST_NOT",
    };
    expect(applyTyping(first, typed)).toMatchObject({
      value: 15,
      typed_by: TYPING_MODEL,
      agreed: null,
      retype_rejected: "NUMBER_NOT_IN_QUOTE:value=12",
    });
  });

  test("exposes HTTP status on a typed failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion({}, { status: 402 }));
    const result = await typeRule(rule(), options(fetchMock));
    expect(result).toMatchObject({ ok: false, status: 402 });
    expect(new TokenFactoryError("test", 402).status).toBe(402);
  });
});
