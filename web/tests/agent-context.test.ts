import { describe, expect, test, vi } from "vitest";
import { AGENT_SYSTEM_PROMPT, questionWithContext } from "@/lib/agent/loop";
import { AGENT_TOOL_DEFINITIONS, createAgentToolRuntime, executeAgentTool } from "@/lib/agent/tools";

describe("Ask the tank checks what the page shows", () => {
  test("the question carries the page's field, tank, job length and forecast", () => {
    const content = questionWithContext("Which label sets the strictest wind limit in this tank?", {
      field: "tift",
      products: ["5481-504", "264-700", "264-418"],
      jobHours: 3,
      forecast: "recorded",
    });
    expect(content).toBe(
      "Which label sets the strictest wind limit in this tank?\n\n"
      + "Page context: field tift; products 5481-504, 264-700, 264-418; job length 3 hours; forecast recorded.",
    );
  });

  test("a job length or field named in the question replaces the page's", () => {
    const page = { field: "tift", products: ["5481-504"], jobHours: 3, forecast: "recorded" as const };
    expect(questionWithContext("When can I spray at Worth for a 4-hour job?", page)).toContain("field worth; products 5481-504; job length 4 hours");
    expect(questionWithContext("Is Ben Hill open for a 6-hour job tomorrow?", page)).toContain("field ben_hill; products 5481-504; job length 6 hours");
    expect(questionWithContext("Can I spray at cook for a job of 5 hours?", page)).toContain("field cook; products 5481-504; job length 5 hours");
    expect(questionWithContext("Why is the next hour blocked?", page)).toContain("field tift; products 5481-504; job length 3 hours");
    expect(questionWithContext("Can I run a 40-hour job?", page)).toContain("job length 3 hours");
  });

  test("ordinary words and label conditions do not change the page's field or job", () => {
    const page = { field: "tift", products: ["5481-504"], jobHours: 3, forecast: "recorded" as const };
    expect(questionWithContext("Is it worth spraying today?", page)).toContain("field tift;");
    expect(questionWithContext("Why can't I spray if rain is expected within 6 hours?", page)).toContain("job length 3 hours");
    expect(questionWithContext("Does Dropp need a 24-hour rain-free period?", page)).toContain("job length 3 hours");
  });

  test("without a page the question goes as typed", () => {
    expect(questionWithContext("When can I spray?")).toBe("When can I spray?");
  });

  test("the prompt tells the model to use the context and answer the question asked", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("page context line");
    expect(AGENT_SYSTEM_PROMPT).toContain("Answer the question that was asked.");
  });

  test("check_tank offers the recorded forecast and refuses any other value", async () => {
    const checkTank = AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === "check_tank")!;
    expect(checkTank.function.parameters).toMatchObject({ properties: { forecast: { enum: ["live", "recorded"] } } });
    await expect(executeAgentTool(
      "check_tank",
      { field: "tift", products: ["5481-504"], job_hours: 3, forecast: "tomorrow" },
      createAgentToolRuntime(),
    )).rejects.toThrow("check_tank forecast must be live or recorded.");
  });
});

describe("a slow Token Factory step", () => {
  test("is tried once more before the run reports the timeout", async () => {
    const { runAgentLoop } = await import("@/lib/agent/loop");
    const statuses: string[] = [];
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "Token Factory did not respond within 25000 milliseconds.", status: 504 }),
      { status: 504, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(runAgentLoop("When can I spray?", (status) => statuses.push(status))).rejects.toThrow("did not respond within 25000 milliseconds");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(statuses.some((status) => status.includes("trying once more"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
