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

  // Production 2026-10-05: the planner returned two windows and these true answers were refused four
  // times each, first for the word "only", then for "7 PM. Wed window" read as seven windows. The
  // adversarial review added the two scoped answers. The guard no longer reads counts from prose, so
  // each must pass in full; the fixture carries the numbers the planner reported (4, 11 and 15 hours).
  const productionCheck = (): ToolResultRecord[] => [
    {
      name: "check_tank",
      result: {
        job_hours: 4,
        forecast_permitted_hours: 15,
        windows: [
          { index: 0, label: "Wed Oct 7, 3 PM to 7 PM (4 h)" },
          { index: 1, label: "Thu Oct 8, 8 AM to 7 PM (11 h)" },
        ],
        binding_clauses: [{ rule_id: "264-700-p8-3", page: 8 }],
      },
    },
  ];

  test.each([
    "Two 4‑hour windows are forecast‑permitted for spraying all three products at Tift this week: Wed Oct 7 3‑7 PM and Thu Oct 8 8 AM‑7 PM.  The planner counts 15 forecast‑permitted slots total, but only the two windows meet the 4‑hour job requirement.  Remember that field checks required by the label remain your responsibility.",
    "Two forecast-permitted windows for a 4‑hour job at Tift this week: Wed Oct 7 3‑7 PM and Thu Oct 8 8 AM‑7 PM. Wed window meets the 4‑hour requirement; Thu window is 11 hours and also permitted. Both windows are subject to label‑required field checks (rain chance, temperature inversion, wind speed limits). Remind the user that field checks required by the label remain their responsibility.",
    "Only one available window starts at three PM; the other starts at seven PM.",
    "One available window is Wednesday. One available window is Thursday.",
  ])("accepts a true answer about two windows: %s", (summary) => {
    expect(guardFinalAnswer({ summary, cited_rule_ids: ["264-700-p8-3"], window_indices: [0, 1] }, productionCheck()))
      .toEqual({ passed: true, reasons: [] });
  });

  test("still rejects an invented rule, window or number in the same answer", () => {
    const result = guardFinalAnswer(
      { summary: "Two windows; the second runs 12 hours.", cited_rule_ids: ["264-700-p9-9"], window_indices: [0, 1, 2] },
      productionCheck(),
    );
    expect(result.reasons).toEqual([
      "Rule 264-700-p9-9 did not appear in a tool result.",
      "Window 2 did not appear in the latest check_tank result.",
      "Number 12 did not appear in a tool result.",
    ]);
  });
});
