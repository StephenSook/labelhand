import { describe, expect, test } from "vitest";
import { guardFinalAnswer, type ToolResultRecord } from "@/lib/agent/guard";

const toolResults: ToolResultRecord[] = [
  {
    name: "check_tank",
    result: {
      job_hours: 4,
      windows: [{ index: 0, label: "Wed Oct 7, 3 PM to 7 PM (4 h)" }],
      binding_clauses: [{ rule_id: "264-700-p8-3", page: 8 }],
    },
  },
];

describe("final answer guard", () => {
  test("accepts a grounded answer", () => {
    expect(guardFinalAnswer({
      summary: "Window 0 provides 4 forecast-permitted hours. See page 8.",
      cited_rule_ids: ["264-700-p8-3"],
      window_indices: [0],
    }, toolResults)).toEqual({ passed: true, reasons: [] });
  });

  test("rejects an unknown rule id", () => {
    expect(guardFinalAnswer({ summary: "", cited_rule_ids: ["unknown-rule"], window_indices: [] }, toolResults).passed).toBe(false);
  });

  test("rejects an unknown window index", () => {
    expect(guardFinalAnswer({ summary: "", cited_rule_ids: [], window_indices: [3] }, toolResults).passed).toBe(false);
  });

  test("rejects a number absent from tool results", () => {
    expect(guardFinalAnswer({ summary: "Wait 99 hours.", cited_rule_ids: [], window_indices: [] }, toolResults).passed).toBe(false);
  });

  test("rejects an only-window claim when multiple windows exist", () => {
    const results = structuredClone(toolResults);
    (results[0].result as { windows: unknown[] }).windows.push({ index: 1, label: "Thu Oct 8" });
    expect(guardFinalAnswer({ summary: "This is the only window.", cited_rule_ids: [], window_indices: [0] }, results).passed).toBe(false);
  });

  // Production 2026-10-05 19:43Z: a true answer about two windows was refused four times because the
  // guard rejected the word "only" whenever the count was not one. The summary below is that answer's
  // wording (U+2011 non-breaking hyphens as the model wrote them).
  const twoWindows = (): ToolResultRecord[] => {
    const results = structuredClone(toolResults);
    (results[0].result as { windows: unknown[] }).windows.push({ index: 1, label: "Thu Oct 8" });
    return results;
  };

  test("accepts only plus the true window count", () => {
    const summary = "Two 4‑hour windows are forecast‑permitted. Only the two windows meet the 4‑hour job.";
    expect(guardFinalAnswer({ summary, cited_rule_ids: [], window_indices: [0, 1] }, twoWindows())).toEqual({ passed: true, reasons: [] });
  });

  test("rejects a stated window count that differs from the planner", () => {
    expect(guardFinalAnswer({ summary: "Three 4-hour windows fit.", cited_rule_ids: [], window_indices: [0] }, twoWindows()).passed).toBe(false);
    expect(guardFinalAnswer({ summary: "A single window fits.", cited_rule_ids: [], window_indices: [0] }, twoWindows()).passed).toBe(false);
  });

  test("does not read one of the windows as a count", () => {
    expect(guardFinalAnswer({ summary: "One of the windows starts Wed.", cited_rule_ids: [], window_indices: [0] }, twoWindows()).passed).toBe(true);
  });
});
