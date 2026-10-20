// Which tools the model may call next. One forced tool by name keeps Lightning to a short tool call;
// two tools with tool_choice "required" let it write a call and keep generating toward max_tokens,
// which on 2026-10-20 took longer than the route's 25 s on every run that reached it. So the agent
// gets at most one get_clause round, then must answer.
export type ToolChoiceMessage = { role: string; name?: string; content?: string | null };

function succeeded(message: ToolChoiceMessage, name: string): boolean {
  if (message.role !== "tool" || message.name !== name || typeof message.content !== "string") return false;
  try {
    const result = JSON.parse(message.content) as unknown;
    return !(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string");
  } catch {
    return false;
  }
}

export function allowedToolNames(messages: readonly ToolChoiceMessage[]): Set<string> {
  const firstQuestion = messages.find((message) => message.role === "user")?.content ?? "";
  if (!messages.some((message) => succeeded(message, "check_tank"))) return new Set(["check_tank"]);
  if (/\bwhen\b|\bwindows?\b/i.test(firstQuestion)) return new Set(["final_answer"]);
  if (messages.some((message) => succeeded(message, "get_clause"))) return new Set(["final_answer"]);
  return new Set(["get_clause", "final_answer"]);
}
