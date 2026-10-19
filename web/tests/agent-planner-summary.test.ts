import { describe, expect, test } from "vitest";
import { plannerSummary } from "@/lib/agent/loop";
import type { AgentCheckTankResult } from "@/lib/agent/tools";

const base: AgentCheckTankResult = {
  field: "Tift",
  products: ["5481-504", "264-700", "264-418"],
  job_hours: 4,
  source: { kind: "LIVE", time: "2026-10-19T17:28:00Z" },
  counts: { FORECAST_PERMITTED: 0, FIELD_CHECK: 0, BLOCKED: 156 },
  windows: [],
  binding_clauses: [
    { rule_id: "5481-504-p10-10", product: "FOLEX 6 EC", page: 10, quote: "minimum night temperature", why: "night low 48 F", hour_label: "Mon, Oct 19, 2 PM" },
    { rule_id: "5481-504-p8-4", product: "FOLEX 6 EC", page: 8, quote: "Do not apply when wind speed exceeds 10 mph", why: "wind 15 mph", hour_label: "Mon, Oct 19, 3 PM" },
    { rule_id: "264-700-p5-1", product: "DROPP SC", page: 5, quote: "wind", why: "wind 15 mph", hour_label: "Mon, Oct 19, 3 PM" },
    { rule_id: "264-418-p5-13", product: "PREP", page: 5, quote: "inversion", why: "inversion", hour_label: "Mon, Oct 19, 9 PM" },
  ],
};

describe("planner summary written without the model", () => {
  test("names the field, job, source and the first three clauses when no window was returned", () => {
    expect(plannerSummary(base)).toBe(
      "No forecast-permitted window (Tift, 4-hour job, live forecast fetched 2026-10-19T17:28:00Z). First clauses that blocked or flagged hours: "
      + "5481-504-p10-10 (FOLEX 6 EC): \"minimum night temperature\"; 5481-504-p8-4 (FOLEX 6 EC): \"Do not apply when wind speed exceeds 10 mph\"; 264-700-p5-1 (DROPP SC): \"wind\"",
    );
  });

  test("lists every returned window and the field-check reminder when windows exist", () => {
    const result: AgentCheckTankResult = {
      ...base,
      source: { kind: "RECORDED", time: "2026-10-07T12:00:00Z" },
      windows: [
        { index: 0, label: "Wed, Oct 7, 3 PM to Wed, Oct 7, 7 PM (4 h)", start: "a", end: "b", hours: 4 },
        { index: 1, label: "Thu, Oct 8, 8 AM to Thu, Oct 8, 7 PM (11 h)", start: "c", end: "d", hours: 11 },
      ],
    };
    expect(plannerSummary(result)).toBe(
      "Forecast-permitted windows (Tift, 4-hour job, recorded forecast fetched 2026-10-07T12:00:00Z): window 0, Wed, Oct 7, 3 PM to Wed, Oct 7, 7 PM (4 h); window 1, Thu, Oct 8, 8 AM to Thu, Oct 8, 7 PM (11 h). Field checks required by the label remain your responsibility.",
    );
  });
});
