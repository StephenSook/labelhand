import { guardFinalAnswer, type FinalAnswerArgs, type ToolResultRecord } from "./guard";
import {
  AGENT_TOOL_NAMES,
  createAgentToolRuntime,
  executeAgentTool,
  type AgentCheckSnapshot,
  type AgentToolName,
} from "./tools";

export const AGENT_SYSTEM_PROMPT = `You help a Georgia cotton applicator understand the Labelhand planner. You must use check_tank before answering any question about forecast windows. You may state only facts that appear in tool results from this conversation. Never say spraying is legal. Say forecast-permitted and remind the user that field checks required by the label remain their responsibility. For a when or window question, call check_tank and then call final_answer directly with every returned window index. Never say only unless check_tank returned exactly one window. Use get_clause only when the user asks why or asks about a label limit. Never invent or abbreviate a rule ID. Copy a rule_id exactly from check_tank binding_clauses. End by calling final_answer with a summary, cited rule IDs, and window indices. Do not answer in ordinary text.`;

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type AgentMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type AgentModelTrace = {
  type: "model";
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  requestId: string | null;
};

export type AgentToolTrace = {
  type: "tool";
  name: string;
  args: unknown;
  ms: number;
  resultSummary: string;
};

export type AgentGuardTrace = {
  type: "guard";
  passed: boolean;
  reasons: string[];
};

export type AgentTraceEntry = AgentModelTrace | AgentToolTrace | AgentGuardTrace;

export type AgentRunResult = {
  answer: FinalAnswerArgs | null;
  fallbackText: string | null;
  guard: AgentGuardTrace;
  trace: AgentTraceEntry[];
  latestCheck?: AgentCheckSnapshot;
  totalCostUsd: number;
};

type RouteResponse = {
  message?: AgentMessage;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  requestId?: string | null;
  error?: string;
};

const MAX_MODEL_CALLS = 6;
const MAX_MESSAGES = 14;

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("The model returned tool arguments that were not valid JSON.");
  }
}

function isToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

export async function runAgentLoop(
  question: string,
  onStatus?: (status: string) => void,
): Promise<AgentRunResult> {
  const messages: AgentMessage[] = [{ role: "user", content: question }];
  const trace: AgentTraceEntry[] = [];
  const toolResults: ToolResultRecord[] = [];
  const runtime = createAgentToolRuntime();
  let totalCostUsd = 0;
  let lastGuard: AgentGuardTrace | null = null;

  for (let callIndex = 0; callIndex < MAX_MODEL_CALLS; callIndex += 1) {
    if (messages.length > MAX_MESSAGES) {
      const sequence = trace.map((entry) => entry.type === "tool" ? `tool:${entry.name}` : entry.type).join(", ");
      throw new Error(`The agent reached the 14-message conversation limit before final_answer. Partial trace: ${sequence}.`);
    }
    onStatus?.(`Calling Nemotron, model step ${callIndex + 1} of ${MAX_MODEL_CALLS}`);
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const payload = await response.json() as RouteResponse;
    if (!response.ok || !payload.message) {
      throw new Error(payload.error ?? `The agent route returned HTTP ${response.status}.`);
    }
    const modelTrace: AgentModelTrace = {
      type: "model",
      model: payload.model ?? "unknown",
      latencyMs: payload.latencyMs ?? 0,
      tokensIn: payload.usage?.inputTokens ?? 0,
      tokensOut: payload.usage?.outputTokens ?? 0,
      costUsd: payload.costUsd ?? 0,
      requestId: payload.requestId ?? null,
    };
    trace.push(modelTrace);
    totalCostUsd += modelTrace.costUsd;
    messages.push(payload.message);

    const toolCalls = payload.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      messages.push({
        role: "user",
        content: "Use the available tools. Finish only with final_answer.",
      });
      continue;
    }

    let executedInThisTurn = false;
    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      if (!isToolName(name)) throw new Error(`The model requested unknown tool ${name}.`);
      const args = parseArguments(toolCall.function.arguments);
      onStatus?.(`Running ${name}`);
      const started = performance.now();
      if (executedInThisTurn) {
        const failedResult = { error: "Tool calls are sequential. Read the first tool result, then request one next tool." };
        trace.push({
          type: "tool",
          name,
          args,
          ms: 0,
          resultSummary: `Tool refused the call: ${failedResult.error}`,
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(failedResult),
        });
        continue;
      }
      executedInThisTurn = true;
      let executed: Awaited<ReturnType<typeof executeAgentTool>>;
      try {
        executed = await executeAgentTool(name, args, runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedResult = { error: message };
        trace.push({
          type: "tool",
          name,
          args,
          ms: Math.round(performance.now() - started),
          resultSummary: `Tool refused the call: ${message}`,
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(failedResult),
        });
        continue;
      }
      trace.push({
        type: "tool",
        name,
        args,
        ms: Math.round(performance.now() - started),
        resultSummary: executed.summary,
      });

      if (name === "final_answer") {
        const answer = executed.result as FinalAnswerArgs;
        const checked = guardFinalAnswer(answer, toolResults);
        const guard: AgentGuardTrace = { type: "guard", ...checked };
        lastGuard = guard;
        trace.push(guard);
        if (checked.passed) {
          return {
            answer,
            fallbackText: null,
            guard,
            trace,
            latestCheck: runtime.latestCheck,
            totalCostUsd,
          };
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify({
            error: "The deterministic final-answer guard rejected this answer. Correct every cited value and call final_answer again.",
            reasons: checked.reasons,
          }),
        });
        continue;
      }

      toolResults.push({ name, result: executed.result });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify(executed.result),
      });
    }
  }

  if (lastGuard) {
    return {
      answer: null,
      fallbackText: `The answer cited something the tools did not return, so it is not shown. Here is what the tools returned.\n\n${JSON.stringify(toolResults, null, 2)}`,
      guard: lastGuard,
      trace,
      latestCheck: runtime.latestCheck,
      totalCostUsd,
    };
  }
  throw new Error(`Nemotron did not call final_answer within ${MAX_MODEL_CALLS} model calls.`);
}
