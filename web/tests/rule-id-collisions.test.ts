import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Citation, Rule } from "@/engine";
import { createAgentToolRuntime, executeAgentTool } from "@/lib/agent/tools";
import { collapseRepeatedClauses } from "@/lib/citations";

const prepRain = "DO NOT APPLY PREP BRAND ETHEPHON FOR COTTON AND TOBACCO IF RAIN IS EXPECTED WITHIN 6 HOURS.";

function rule(id: string, param: string, quote: string): Rule {
  return { id, page: 9, product: "FOLEX 6 EC", reg: "5481-504", param, op: "none", unit: null, modality: "ADVISORY", quote };
}

function citation(rule: string, quote: string, why = "rain chance up to 72% within 6 h"): Citation {
  return { product: "PREP", rule, page: 9, quote, why };
}

describe("one rule id that names more than one clause", () => {
  test("the shipped labels really do repeat ids after merging, so the agent must not assume they are unique", () => {
    const ship = JSON.parse(readFileSync(path.join(process.cwd(), "public/data/compiled/5481-504.ship.json"), "utf8")) as { accepted: Rule[] };
    const sameId = ship.accepted.filter((candidate) => candidate.id === "5481-504-p9-2").map((candidate) => candidate.param);
    expect(sameId).toEqual(expect.arrayContaining(["wind_speed_mph", "temperature_inversion"]));
  });

  test("get_clause returns every clause under a shared id", async () => {
    const runtime = createAgentToolRuntime();
    runtime.rulesById.set("5481-504-p9-2", [
      rule("5481-504-p9-2", "wind_speed_mph", "Application should be avoided below 2 mph."),
      rule("5481-504-p9-2", "temperature_inversion", "Temperature inversions are characterized by increasing temperature with altitude."),
    ]);
    const { result } = await executeAgentTool("get_clause", { rule_id: "5481-504-p9-2" }, runtime);
    expect(result).toMatchObject({
      rule_id: "5481-504-p9-2",
      param: "wind_speed_mph",
      quote: "Application should be avoided below 2 mph.",
      other_clauses_with_this_id: [{ param: "temperature_inversion", quote: expect.stringContaining("Temperature inversions") }],
    });
    expect((result as { note: string }).note).toContain("names 2 clauses");
  });

  test("get_clause keeps its plain shape when an id names one clause", async () => {
    const runtime = createAgentToolRuntime();
    runtime.rulesById.set("5481-504-p8-4", [rule("5481-504-p8-4", "wind_speed_mph", "Do not apply when wind speed exceeds 10 mph.")]);
    const { result } = await executeAgentTool("get_clause", { rule_id: "5481-504-p8-4" }, runtime);
    expect(result).not.toHaveProperty("other_clauses_with_this_id");
    expect(result).toMatchObject({ rule_id: "5481-504-p8-4", quote: "Do not apply when wind speed exceeds 10 mph." });
  });
});

describe("hour card clauses", () => {
  test("one sentence cited twice under one id shows once, with the longer quote", () => {
    const shown = collapseRepeatedClauses([
      citation("264-418-p9-5", `${prepRain} Rainfall within 6 hours of application may reduce product performance.`),
      citation("264-418-p9-5", prepRain),
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.quote).toContain("may reduce product performance");
  });

  test("two different sentences under one id both stay", () => {
    const shown = collapseRepeatedClauses([
      citation("5481-504-p10-10", "When minimum night temperature is below 60 F, use FOLEX 6 EC alone.", "night low 58 F"),
      citation("5481-504-p10-10", "Use the high rate of thidiazuron when night temperatures are below 60 F.", "night low 58 F"),
    ]);
    expect(shown).toHaveLength(2);
  });

  test("the same sentence for a different reason is a different clause", () => {
    const shown = collapseRepeatedClauses([citation("264-418-p9-5", prepRain), citation("264-418-p9-5", prepRain, "rain chance 55% within 6 h")]);
    expect(shown).toHaveLength(2);
  });
});
