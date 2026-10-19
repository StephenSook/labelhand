import { describe, expect, test, vi } from "vitest";

import { answerWhyWithAgent } from "@/lib/alerts/agent";
import type { AlertPlannerEvidence } from "@/lib/alerts/types";

const fallback = "The planner's own summary is spoken.";
const evidence: AlertPlannerEvidence = {
  fieldKey: "tift",
  fieldName: "Tift",
  products: [{ reg: "5481-504", name: "Folex 6 EC" }],
  source: "LIVE",
  fetchedAt: "2026-10-06T10:00:00.000Z",
  jobHours: 3,
  calledWindow: { start: "2026-10-07T13:00:00-04:00", end: "2026-10-07T16:00:00-04:00", hours: 3 },
  agentCheck: {
    field: "Tift",
    products: ["5481-504"],
    job_hours: 3,
    source: { kind: "LIVE", time: "2026-10-06T10:00:00.000Z" },
    counts: { FORECAST_PERMITTED: 3, FIELD_CHECK: 2, BLOCKED: 4 },
    windows: [{ index: 0, label: "window", start: "2026-10-07T13:00:00-04:00", end: "2026-10-07T16:00:00-04:00", hours: 3 }],
    binding_clauses: [{
      rule_id: "5481-504-p3-1",
      product: "FOLEX 6 EC",
      page: 3,
      quote: "Do not apply during a temperature inversion.",
      why: "temperature inversion requires a field check",
      hour_label: "Wed, Oct 7, 6 PM",
    }],
  },
  fallbackSummary: fallback,
};

function completion(answer: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "final_answer", arguments: JSON.stringify(answer) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("voice why agent", () => {
  test("uses the existing final-answer guard", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion({
      summary: "The Folex inversion clause limits the remaining hours.",
      cited_rule_ids: ["5481-504-p3-1"],
      window_indices: [0],
    }));
    await expect(answerWhyWithAgent(evidence, { apiKey: "test-key", fetchImpl: fetchMock }))
      .resolves.toBe("The Folex inversion clause limits the remaining hours.");
    expect(timeoutSpy).toHaveBeenCalledWith(8_000);
  });

  test("speaks the planner fallback when the model, parse, or guard fails", async () => {
    const badCitation = vi.fn<typeof fetch>().mockResolvedValue(completion({
      summary: "An unsupported clause limits the remaining hours.",
      cited_rule_ids: ["invented-rule"],
      window_indices: [0],
    }));
    await expect(answerWhyWithAgent(evidence, { apiKey: "test-key", fetchImpl: badCitation })).resolves.toBe(fallback);
    await expect(answerWhyWithAgent(evidence, {
      apiKey: "test-key",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    })).resolves.toBe(fallback);
  });
});
