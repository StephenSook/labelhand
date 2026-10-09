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

  // Run 37819901943 (2026-10-08 17:54 UTC) returned 4 permitted windows. The summary is the
  // recorded final answer. The log is not downloadable, so windows 1 to 3 are placeholders with
  // no recorded labels. Window 0 repeats the span named in the answer. 38 and 71 are the
  // forecast-wide counts named in that answer. The blocked-hour total was not recorded.
  const productionAnswer20261008 =
    "At Tift this week the only forecast-permitted window that allows all three products ... for a 4-hour job is Thursday October 8 from 1 PM to 7 PM (6-hour window). The planner reports 38 forecast-permitted counts and 71 field-check required counts for that window. All other listed windows have wind-speed or rain-inversion restrictions that would block one or更多产";

  const tiftFourWindows = (): ToolResultRecord[] => [
    {
      name: "check_tank",
      result: {
        field: "Tift",
        products: ["5481-504", "264-700", "264-418"],
        job_hours: 4,
        counts: { FORECAST_PERMITTED: 38, FIELD_CHECK: 71 },
        windows: [
          { index: 0, label: "Thu Oct 8, 1 PM to 7 PM (6 h)", hours: 6 },
          { index: 1, label: "placeholder", hours: 4 },
          { index: 2, label: "placeholder", hours: 4 },
          { index: 3, label: "placeholder", hours: 4 },
        ],
        binding_clauses: [{ rule_id: "264-700-p8-3", page: 8 }],
      },
    },
  ];

  test("rejects Han characters even when the sentence is otherwise finished", () => {
    const result = guardFinalAnswer(
      { summary: "Window 0 provides 4 forecast-permitted hours 更.", cited_rule_ids: [], window_indices: [0] },
      toolResults,
    );
    expect(result.reasons).toEqual(["The final answer contains characters outside Latin script (Han)."]);
  });

  test("rejects Cyrillic characters", () => {
    const result = guardFinalAnswer(
      { summary: "The forecast window is закрыто.", cited_rule_ids: [], window_indices: [] },
      toolResults,
    );
    expect(result.reasons).toEqual(["The final answer contains characters outside Latin script (Cyrillic)."]);
  });

  test("rejects Greek characters", () => {
    const result = guardFinalAnswer(
      { summary: "The forecast window is ανοιχτό.", cited_rule_ids: [], window_indices: [] },
      toolResults,
    );
    expect(result.reasons).toEqual(["The final answer contains characters outside Latin script (Greek)."]);
  });

  test("rejects a summary that does not end with sentence-final punctuation", () => {
    const result = guardFinalAnswer(
      { summary: "Window 0 provides 4 forecast-permitted hours", cited_rule_ids: [], window_indices: [0] },
      toolResults,
    );
    expect(result.reasons).toEqual(["The summary does not end with sentence-final punctuation."]);
  });

  test.each([
    "Does window 0 provide 4 forecast-permitted hours?",
    "Window 0 provides 4 forecast-permitted hours!",
    "Window 0 provides 4 forecast-permitted hours.\"",
  ])("accepts a finished Latin sentence: %s", (summary) => {
    expect(guardFinalAnswer({ summary, cited_rule_ids: [], window_indices: [0] }, toolResults))
      .toEqual({ passed: true, reasons: [] });
  });

  test("accepts a finished Latin answer that reports the same hours without a script break", () => {
    const summary = "Thursday October 8 from 1 PM to 7 PM is a 6-hour forecast-permitted window for a 4-hour job at Tift. The planner reports 38 forecast-permitted hours and 71 field-check hours across the forecast. Other returned windows are forecast-permitted too.";
    expect(guardFinalAnswer(
      { summary, cited_rule_ids: ["264-700-p8-3"], window_indices: [0, 1, 2, 3] },
      tiftFourWindows(),
    )).toEqual({ passed: true, reasons: [] });
  });

  test("rejects the 2026-10-08 production answer for script, a cut-off sentence, and exclusivity", () => {
    const result = guardFinalAnswer(
      { summary: productionAnswer20261008, cited_rule_ids: [], window_indices: [0] },
      tiftFourWindows(),
    );
    expect(result.reasons).toEqual([
      "The final answer contains characters outside Latin script (Han).",
      "The summary does not end with sentence-final punctuation.",
      exclusivityReason(4),
    ]);
  });

  function exclusivityReason(count: number): string {
    return `The summary claims a single permitted window, or that the other windows are blocked, but check_tank returned ${count} permitted windows.`;
  }

  function windowsForCount(count: number): ToolResultRecord[] {
    const results = structuredClone(toolResults);
    const windows = (results[0].result as { windows: Array<{ index: number; label: string }> }).windows;
    for (let index = windows.length; index < count; index += 1) {
      windows.push({ index, label: "placeholder" });
    }
    return results;
  }

  test("accepts the only window when check_tank returned one", () => {
    expect(guardFinalAnswer(
      { summary: "This is the only window.", cited_rule_ids: [], window_indices: [0] },
      windowsForCount(1),
    )).toEqual({ passed: true, reasons: [] });
  });

  test.each([
    "This is the only window.",
    "This is the sole window.",
    "A single window fits.",
    "Just one forecast-permitted window fits.",
    "No other window is forecast-permitted.",
    "All other windows are blocked.",
    "All other listed windows would block one product.",
    "The rest are blocked.",
    "The rest are not permitted.",
    "Only one window fits the job.",
    "Only one available window fits the job.",
    "Only one window fits; the other is blocked.",
  ])("rejects an exclusivity claim when check_tank returned two windows: %s", (summary) => {
    const result = guardFinalAnswer(
      { summary, cited_rule_ids: [], window_indices: [0, 1] },
      windowsForCount(2),
    );
    expect(result.reasons).toEqual([exclusivityReason(2)]);
  });

  test.each([
    "All other windows are not blocked.",
    "All other windows would not block the job.",
    "Only the two windows meet the 4-hour job.",
    "Just one available window starts at three PM; the other starts at seven PM.",
    "The rest are not blocked.",
  ])("does not treat a non-exclusive sentence as one window: %s", (summary) => {
    expect(guardFinalAnswer(
      { summary, cited_rule_ids: [], window_indices: [0, 1] },
      windowsForCount(2),
    )).toEqual({ passed: true, reasons: [] });
  });

  test("compares exclusivity with the latest check_tank result", () => {
    const result = guardFinalAnswer(
      { summary: "This is the only window.", cited_rule_ids: [], window_indices: [0] },
      [...windowsForCount(1), ...windowsForCount(4)],
    );
    expect(result.reasons).toEqual([exclusivityReason(4)]);
  });
});
