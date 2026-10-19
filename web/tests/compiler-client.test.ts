import { describe, expect, test, vi } from "vitest";

import {
  LiveCompileClientError,
  readCompileStream,
  requestLiveCompile,
} from "@/lib/compiler/client";
import type { CompiledLiveLabel, PipelineEvent } from "@/lib/compiler/pipeline";

function compiled(): CompiledLiveLabel {
  return {
    reg: "100-1256",
    product: "AXIAL XL",
    label_accepted: "2022-05-03",
    label_sha256: "a".repeat(64),
    label_url: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
    label_file: "000100-01256-20220503.pdf",
    model: "super",
    retype_model: "ultra",
    pipeline_version: "test-v1",
    extractor: "pdfjs-test",
    compiled_utc: "2026-10-19T20:00:00.000Z",
    scored: false,
    restricted_use: false,
    complete: true,
    pages: 1,
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

function chunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

describe("live compiler client", () => {
  test("reads events split across arbitrary response chunks", async () => {
    const done = JSON.stringify({ type: "done", compiled: compiled() });
    const response = chunkedResponse([
      '{"type":"listed","reg":"100-1256","product":"AXIAL XL",',
      `"fileName":"000100-01256-20220503.pdf","accepted":"2022-05-03"}\n${done.slice(0, 20)}`,
      `${done.slice(20)}\n`,
    ]);
    const events: PipelineEvent[] = [];
    await expect(readCompileStream(response, (event) => {
      events.push(event);
    })).resolves.toEqual(compiled());
    expect(events.map(({ type }) => type)).toEqual(["listed", "done"]);
  });

  test("throws the streamed public error reason", async () => {
    const response = chunkedResponse(['{"type":"error","reason":"daily budget reached"}\n']);
    await expect(readCompileStream(response)).rejects.toThrow("daily budget reached");
  });

  test("surfaces a JSON HTTP error before reading a stream", async () => {
    const response = new Response(JSON.stringify({ error: "disabled" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    await expect(readCompileStream(response)).rejects.toMatchObject<Partial<LiveCompileClientError>>({
      message: "disabled",
      status: 503,
    });
  });

  test("cancels the response stream when an event consumer fails", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          '{"type":"listed","reg":"100-1256","product":"AXIAL XL","fileName":"label.pdf","accepted":"2022-05-03"}\n',
        ));
      },
      cancel() {
        cancelled = true;
      },
    }));
    await expect(readCompileStream(response, () => {
      throw new Error("consumer failed");
    })).rejects.toThrow("consumer failed");
    expect(cancelled).toBe(true);
  });

  test("posts only the registration number to the compile route", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(chunkedResponse([
      `${JSON.stringify({ type: "cached", compiled: compiled() })}\n`,
    ]));
    await expect(requestLiveCompile("100-1256", undefined, fetchMock, controller.signal)).resolves.toEqual(compiled());
    expect(fetchMock).toHaveBeenCalledWith("/api/labels/compile", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reg: "100-1256" }),
      signal: controller.signal,
    }));
  });
});
