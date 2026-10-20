import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";

import { evaluate, filterRules, initializeEngine, type ForecastPeriod } from "@/engine";
import {
  assertCompiledShape,
  compileLiveLabel,
  hasRestrictedUsePhrase,
  PIPELINE_VERSION,
  PipelineError,
  type LiveCompileInput,
  type PipelineEvent,
} from "@/lib/compiler/pipeline";
import { sha256 } from "@/lib/ppls";

function completion(
  content: unknown,
  requestId: string,
  usage = { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
    usage,
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

async function labelPdf(pageCount = 1): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage().drawText(
      "Do not apply when wind speeds exceed 15 mph. This additional label text keeps the page readable for a live compile.",
      { x: 30, y: 700, size: 10, font },
    );
  }
  const pdf = await document.save({ useObjectStreams: false });
  const padded = new Uint8Array(20_000);
  padded.set(pdf);
  return padded;
}

function firstPassRule() {
  return {
    kind: "forecast_series",
    modality: "MUST_NOT",
    param: "wind_speed_mph",
    op: "gt",
    value: 15,
    value2: null,
    unit: "mph",
    applies_to: "all applications",
    summary: "wind limit",
    quote: "Do not apply when wind speeds exceed 15 mph.",
  };
}

function typedRule() {
  return {
    param: "wind_speed_mph",
    op: "gt",
    value: 15,
    value2: null,
    unit: "mph",
    modality: "MUST_NOT",
  };
}

function schemaName(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as {
    response_format: { json_schema: { name: string } };
  };
  return body.response_format.json_schema.name;
}

function compilerFetch(options: {
  firstPass?: unknown;
  typed?: unknown;
  failFirst?: boolean;
} = {}) {
  let calls = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    calls += 1;
    if (options.failFirst && calls === 1) {
      return new Response("credit exhausted", { status: 402 });
    }
    const content = schemaName(init) === "label_rules"
      ? (options.firstPass ?? { rules: [firstPassRule()] })
      : (options.typed ?? typedRule());
    return completion(content, `req-${calls}`);
  });
}

function liveInput(bytes: Uint8Array, fetchImpl?: typeof fetch): LiveCompileInput {
  return {
    reg: "100-1256",
    product: "AXIAL XL",
    alternateBrandNames: [],
    fileName: "000100-01256-20220503.pdf",
    accepted: "2022-05-03",
    labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
    labelSha256: sha256(bytes),
    pdfBytes: bytes,
    apiKey: "test-key-that-is-never-sent",
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

describe("live compiler pipeline", () => {
  test("runs exactly three concurrent readings and produces a shape the committed WASM evaluates", async () => {
    const bytes = await labelPdf();
    let activeFirstPasses = 0;
    let maximumFirstPasses = 0;
    let firstPassCalls = 0;
    let requestNumber = 0;
    const waiting: Array<() => void> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      requestNumber += 1;
      if (schemaName(init) === "label_rules") {
        firstPassCalls += 1;
        activeFirstPasses += 1;
        maximumFirstPasses = Math.max(maximumFirstPasses, activeFirstPasses);
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 3) waiting.splice(0).forEach((release) => release());
        });
        activeFirstPasses -= 1;
        return completion({ rules: [firstPassRule()] }, `req-first-${requestNumber}`);
      }
      return completion(typedRule(), `req-type-${requestNumber}`);
    });
    const events: PipelineEvent[] = [];
    const compiled = await compileLiveLabel({
      ...liveInput(bytes, fetchMock),
      now: () => new Date("2026-10-19T20:00:00Z"),
    }, (event) => {
      events.push(event);
    });

    expect(firstPassCalls).toBe(3);
    expect(maximumFirstPasses).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(PIPELINE_VERSION).toContain("live-readings-3-merge-v1");
    expect(compiled).toMatchObject({
      scored: false,
      restricted_use: false,
      complete: true,
      pipeline_version: PIPELINE_VERSION,
      readings: 3,
      tokens_in: 6_000,
      tokens_out: 600,
      total_tokens: 6_600,
    });
    expect(compiled.reading_records).toHaveLength(3);
    expect(compiled.reading_records.map(({ reading, attempts, accepted_rules }) => ({
      reading,
      attempts,
      accepted_rules,
    }))).toEqual([
      { reading: 1, attempts: 1, accepted_rules: 1 },
      { reading: 2, attempts: 1, accepted_rules: 1 },
      { reading: 3, attempts: 1, accepted_rules: 1 },
    ]);
    expect(compiled.accepted).toEqual([
      expect.objectContaining({
        found_in_runs: ["reading-1", "reading-2", "reading-3"],
        modality_by_run: {
          "reading-1": "MUST_NOT",
          "reading-2": "MUST_NOT",
          "reading-3": "MUST_NOT",
        },
        modality_vote: { MUST_NOT: 3 },
      }),
    ]);
    expect(events[0]?.type).toBe("pdf");
    expect(events[1]?.type).toBe("extracted");
    expect(events.at(-1)?.type).toBe("done");
    // Every reading streams its own progress, tagged, so the page can show all three advance.
    const pages = events.filter(({ type }) => type === "page");
    expect(pages).toHaveLength(3);
    expect(pages).toEqual(expect.arrayContaining([1, 2, 3].map((reading) => (
      expect.objectContaining({ reading, attempt: 1, n: 1, of: 1 })
    ))));
    expect(events.filter(({ type }) => type === "typing")).toHaveLength(3);
    expect(events.filter(({ type }) => type === "floor")).toHaveLength(3);

    const wasm = await readFile(path.join(process.cwd(), "src/engine/pkg/labelhand_core_bg.wasm"));
    await initializeEngine(new Uint8Array(wasm).buffer);
    const filtered = await filterRules(compiled, "100-1256");
    expect(filtered.used).toHaveLength(1);
    const periods: ForecastPeriod[] = [{
      startTime: "2026-10-19T14:00:00-04:00",
      isDaytime: true,
      temperature: 75,
      windSpeed: "20 mph",
      probabilityOfPrecipitation: { value: 0 },
    }];
    const evaluated = await evaluate(filtered.used, periods, 31.45, -83.51, 1);
    expect(evaluated[0].state).toBe("BLOCKED");
    expect(evaluated[0].blocked[0].quote).toBe(firstPassRule().quote);
  });

  test("retries one failed reading once and records every billed request", async () => {
    const bytes = await labelPdf();
    const fetchMock = compilerFetch({ failFirst: true });
    const events: PipelineEvent[] = [];
    const compiled = await compileLiveLabel(liveInput(bytes, fetchMock), (event) => {
      events.push(event);
    });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(compiled.reading_records.map(({ attempts }) => attempts).sort()).toEqual([1, 1, 2]);
    expect(compiled.request_ids).toHaveLength(6);
    expect(compiled.total_tokens).toBe(6_600);
    // The failed first attempt never reached a page, so reading 1 reports only its retry.
    const pages = events.filter(({ type }) => type === "page");
    expect(pages).toHaveLength(3);
    expect(pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ reading: 1, attempt: 2, n: 1, of: 1 }),
      expect.objectContaining({ reading: 2, attempt: 1, n: 1, of: 1 }),
      expect.objectContaining({ reading: 3, attempt: 1, n: 1, of: 1 }),
    ]));
  });

  test("fails closed with a named reading error after its retry", async () => {
    const bytes = await labelPdf();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => (
      new Response("credit exhausted", { status: 402 })
    ));
    await expect(compileLiveLabel(liveInput(bytes, fetchMock))).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/^Live label reading \d failed after one retry: Token Factory credit is exhausted\.$/),
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  test("ties three distinct reading signals to the request abort", async () => {
    const bytes = await labelPdf();
    const requestAbort = new AbortController();
    const readingSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      readingSignals.push(signal);
      if (readingSignals.length === 3) {
        queueMicrotask(() => requestAbort.abort(new PipelineError("The live compile request was cancelled.", 499)));
      }
    }));

    await expect(compileLiveLabel({
      ...liveInput(bytes, fetchMock),
      signal: requestAbort.signal,
    })).rejects.toMatchObject({ status: 499, message: "The live compile request was cancelled." });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(readingSignals).size).toBe(3);
    expect(readingSignals.every(({ aborted }) => aborted)).toBe(true);
  });

  test("rejects malformed strict-schema output before any rule can reach the planner", async () => {
    const bytes = await labelPdf();
    const fetchMock = compilerFetch({
      firstPass: { rules: [{ ...firstPassRule(), value: "15" }] },
    });
    const compiled = await compileLiveLabel(liveInput(bytes, fetchMock));

    expect(compiled.accepted).toEqual([]);
    expect(compiled.rejected).toEqual([expect.objectContaining({ reject_reason: "SCHEMA_INVALID" })]);
  });

  test("rejects a PPLS file name that does not belong to the requested registration", async () => {
    const bytes = await labelPdf();
    await expect(compileLiveLabel({
      ...liveInput(bytes),
      fileName: "000100-01257-20220503.pdf",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01257-20220503.pdf",
    })).rejects.toThrow(/does not match registration/);
  });

  test("fails the cache shape check when a quote is not on its source page", async () => {
    const bytes = await labelPdf();
    const compiled = await compileLiveLabel(liveInput(bytes, compilerFetch()));
    compiled.accepted[0].quote = "A quote that is absent from the EPA page.";
    expect(() => assertCompiledShape(compiled, [firstPassRule().quote])).toThrow(/shape check/);
  });

  test("aborts each reading before typing when billed use crosses its token ceiling", async () => {
    const bytes = await labelPdf();
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      return completion(
        { rules: [] },
        `req-over-ceiling-${calls}`,
        { prompt_tokens: 120_001, completion_tokens: 0, total_tokens: 120_001 },
      );
    });
    const failure = compileLiveLabel(liveInput(bytes, fetchMock));
    await expect(failure).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("token ceiling"),
      usage: expect.objectContaining({ totalTokens: 360_003 }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("includes peer usage that arrives while a token-ceiling abort settles", async () => {
    const bytes = await labelPdf();
    const releases: Array<(response: Response) => void> = [];
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return completion(
          { rules: [] },
          "req-over-ceiling",
          { prompt_tokens: 120_001, completion_tokens: 0, total_tokens: 120_001 },
        );
      }
      return await new Promise<Response>((resolve) => releases.push(resolve));
    });
    const failure = compileLiveLabel(liveInput(bytes, fetchMock));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    releases[0]?.(completion({ rules: [] }, "req-peer-two"));
    releases[1]?.(completion({ rules: [] }, "req-peer-three"));
    await expect(failure).rejects.toMatchObject({
      usage: expect.objectContaining({ totalTokens: 122_201 }),
      requestIds: expect.arrayContaining(["req-over-ceiling", "req-peer-two", "req-peer-three"]),
    });
  });
});

describe("restricted-use classification", () => {
  test("finds the front-panel phrase across a line break and ignores ordinary use text", () => {
    expect(hasRestrictedUsePhrase(["Directions for use", "RESTRICTED USE\nPESTICIDE Due to acute toxicity"])).toBe(true);
    expect(hasRestrictedUsePhrase(["Restricted use pesticide. For retail sale to certified applicators only."])).toBe(true);
    expect(hasRestrictedUsePhrase([
      "Do not use this product in a manner inconsistent with its labeling.",
      "Use restrictions apply.",
    ])).toBe(false);
  });
});
