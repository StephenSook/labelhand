import { describe, expect, test } from "vitest";
import { allowedToolNames, type ToolChoiceMessage } from "@/lib/agent/tool-choice";

const question = (content: string): ToolChoiceMessage => ({ role: "user", content });
const tool = (name: string, content: unknown): ToolChoiceMessage => ({ role: "tool", name, content: JSON.stringify(content) });
const names = (messages: ToolChoiceMessage[]) => [...allowedToolNames(messages)].sort();

describe("which tools the agent may call next", () => {
  test("check_tank comes first", () => {
    expect(names([question("Which label sets the strictest wind limit?")])).toEqual(["check_tank"]);
  });

  test("a failed check_tank does not count", () => {
    expect(names([question("Why blocked?"), tool("check_tank", { error: "No forecast point named x exists." })])).toEqual(["check_tank"]);
  });

  test("a window question answers right after check_tank", () => {
    expect(names([question("When can I spray?"), tool("check_tank", { windows: [] })])).toEqual(["final_answer"]);
  });

  test("other questions may read one clause, then must answer", () => {
    const afterCheck = [question("Why is the next hour blocked?"), tool("check_tank", { windows: [] })];
    expect(names(afterCheck)).toEqual(["final_answer", "get_clause"]);
    expect(names([...afterCheck, tool("get_clause", { rule_id: "264-418-p9-5" })])).toEqual(["final_answer"]);
  });

  test("a failed get_clause leaves the clause round open", () => {
    const messages = [question("Why blocked?"), tool("check_tank", { windows: [] }), tool("get_clause", { error: "Rule x was not returned." })];
    expect(names(messages)).toEqual(["final_answer", "get_clause"]);
  });
});
