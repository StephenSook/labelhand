import { guardFinalAnswer, prepareFinalAnswer, type FinalAnswerArgs } from "@/lib/agent/guard";
import { AGENT_SYSTEM_PROMPT } from "@/lib/agent/loop";
import { AGENT_TOOL_DEFINITIONS } from "@/lib/agent/tools";
import { requestTokenFactoryCompletion } from "@/lib/agent/token-factory";

import type { AlertPlannerEvidence } from "./types";

const FINAL_ANSWER_TOOL = AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === "final_answer")!;
const VOICE_AGENT_TIMEOUT_MS = 8_000;

function parseAnswer(value: string): FinalAnswerArgs {
  const parsed = JSON.parse(value) as Partial<FinalAnswerArgs>;
  if (
    typeof parsed.summary !== "string"
    || !Array.isArray(parsed.cited_rule_ids)
    || parsed.cited_rule_ids.some((item) => typeof item !== "string")
    || !Array.isArray(parsed.window_indices)
    || parsed.window_indices.some((item) => !Number.isInteger(item))
  ) {
    throw new TypeError("The voice answer did not match final_answer.");
  }
  return parsed as FinalAnswerArgs;
}

export async function answerWhyWithAgent(
  evidence: AlertPlannerEvidence,
  input: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const apiKey = input.apiKey ?? process.env.NEBIUS_API_KEY?.trim();
  if (!apiKey) return evidence.fallbackSummary;
  try {
    const completion = await requestTokenFactoryCompletion({
      apiKey,
      systemPrompt: `${AGENT_SYSTEM_PROMPT} The planner result is already supplied below. Explain which cited clauses limit the rest of that Eastern day outside the called window. Keep the spoken summary under 280 characters. Call final_answer once.`,
      messages: [{
        role: "user",
        content: `Why is the rest of the day limited? Stored check_tank result: ${JSON.stringify(evidence.agentCheck)}`,
      }],
      tools: [FINAL_ANSWER_TOOL],
      toolChoice: { type: "function", function: { name: "final_answer" } },
      maxTokens: 450,
      timeoutMs: VOICE_AGENT_TIMEOUT_MS,
      fetchImpl: input.fetchImpl,
    });
    const call = completion.message.tool_calls?.[0];
    if (!call || call.function.name !== "final_answer") return evidence.fallbackSummary;
    const prepared = prepareFinalAnswer(parseAnswer(call.function.arguments));
    const guarded = guardFinalAnswer(prepared.answer, [{ name: "check_tank", result: evidence.agentCheck }]);
    return guarded.passed ? prepared.answer.summary : evidence.fallbackSummary;
  } catch {
    return evidence.fallbackSummary;
  }
}
