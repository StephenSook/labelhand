import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";

import { evaluate, filterRules, initializeEngine, type ForecastPeriod } from "@/engine";
import {
  assertCompiledShape,
  compileLiveLabel,
  PIPELINE_VERSION,
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

describe("live compiler pipeline", () => {
  test("produces a shape the committed WASM filters and evaluates", async () => {
    const bytes = await labelPdf();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({ rules: [firstPassRule()] }, "req-first"))
      .mockResolvedValueOnce(completion(typedRule(), "req-type"));
    const events: PipelineEvent[] = [];
    const compiled = await compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
      fetchImpl: fetchMock,
      now: () => new Date("2026-10-19T20:00:00Z"),
    }, (event) => {
      events.push(event);
    });

    expect(compiled).toMatchObject({
      scored: false,
      complete: true,
      pipeline_version: PIPELINE_VERSION,
      tokens_in: 2_000,
      tokens_out: 200,
      total_tokens: 2_200,
      request_ids: ["req-first", "req-type"],
    });
    expect(compiled.accepted).toHaveLength(1);
    expect(events.map(({ type }) => type)).toEqual([
      "pdf",
      "extracted",
      "page",
      "typing",
      "floor",
      "done",
    ]);

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

  test("rejects malformed strict-schema output before any rule can reach the planner", async () => {
    const bytes = await labelPdf();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion({
      rules: [{ ...firstPassRule(), value: "15" }],
    }, "req-malformed"));
    const compiled = await compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
      fetchImpl: fetchMock,
    });

    expect(compiled.accepted).toEqual([]);
    expect(compiled.rejected).toEqual([expect.objectContaining({ reject_reason: "SCHEMA_INVALID" })]);
  });

  test("rejects a PPLS file name that does not belong to the requested registration", async () => {
    const bytes = await labelPdf();
    await expect(compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01257-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01257-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
    })).rejects.toThrow(/does not match registration/);
  });

  test("fails the cache shape check when a quote is not on its source page", async () => {
    const bytes = await labelPdf();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({ rules: [firstPassRule()] }, "req-first"))
      .mockResolvedValueOnce(completion(typedRule(), "req-type"));
    const compiled = await compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
      fetchImpl: fetchMock,
    });
    compiled.accepted[0].quote = "A quote that is absent from the EPA page.";
    expect(() => assertCompiledShape(compiled, [firstPassRule().quote])).toThrow(/shape check/);
  });

  test("aborts before typing when billed use crosses the compile token ceiling", async () => {
    const bytes = await labelPdf();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion(
      { rules: [] },
      "req-over-ceiling",
      { prompt_tokens: 120_001, completion_tokens: 0, total_tokens: 120_001 },
    ));
    const failure = compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
      fetchImpl: fetchMock,
    });
    await expect(failure).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("token ceiling"),
      usage: expect.objectContaining({ totalTokens: 120_001 }),
      requestIds: ["req-over-ceiling"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("maps Token Factory credit exhaustion to a fatal pipeline error", async () => {
    const bytes = await labelPdf();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("credit exhausted", { status: 402 }));
    await expect(compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ status: 503, message: "Token Factory credit is exhausted." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("includes peer usage that arrives while a token-ceiling abort settles", async () => {
    const bytes = await labelPdf(2);
    let releasePeer: ((response: Response) => void) | undefined;
    const peer = new Promise<Response>((resolve) => {
      releasePeer = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion(
        { rules: [] },
        "req-over-ceiling",
        { prompt_tokens: 120_001, completion_tokens: 0, total_tokens: 120_001 },
      ))
      .mockReturnValueOnce(peer);
    const failure = compileLiveLabel({
      reg: "100-1256",
      product: "AXIAL XL",
      alternateBrandNames: [],
      fileName: "000100-01256-20220503.pdf",
      accepted: "2022-05-03",
      labelUrl: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
      labelSha256: sha256(bytes),
      pdfBytes: bytes,
      apiKey: "test-key-that-is-never-sent",
      fetchImpl: fetchMock,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releasePeer?.(completion(
      { rules: [] },
      "req-peer",
      { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
    ));
    await expect(failure).rejects.toMatchObject({
      usage: expect.objectContaining({ totalTokens: 121_101 }),
      requestIds: ["req-over-ceiling", "req-peer"],
    });
  });
});
