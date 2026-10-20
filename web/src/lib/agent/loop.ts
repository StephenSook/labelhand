import { guardFinalAnswer, prepareFinalAnswer, type FinalAnswerArgs, type ToolResultRecord } from "./guard";
import {
  AGENT_TOOL_NAMES,
  FIELD_KEYS,
  createAgentToolRuntime,
  executeAgentTool,
  type AgentCheckSnapshot,
  type AgentCheckTankResult,
  type AgentToolName,
} from "./tools";

export const AGENT_SYSTEM_PROMPT = `You help a Georgia cotton applicator understand the Labelhand planner. You must use check_tank before answering any question about forecast windows. When the user message ends with a page context line, call check_tank with exactly that field, those products, that job length and that forecast unless the question names others. Answer the question that was asked. For a question about a limit or which label is strictest, read the binding_clauses quotes, use get_clause for the full text, and name the product, the page and the limit. Do not describe windows unless the question asks when. You may state only facts that appear in tool results from this conversation. Never say spraying is legal. Say forecast-permitted and remind the user that field checks required by the label remain their responsibility. For a when or window question, call check_tank and then call final_answer directly with every returned window index. Do not state how many windows there are; the page lists every window index you return. Keep the summary under 300 characters, at most three short sentences. If no window is returned, say so in one sentence and name the clause that blocks the most hours. Counts in check_tank are hours, never windows. Use get_clause only when the user asks why or asks about a label limit. Never invent or abbreviate a rule ID. Copy a rule_id exactly from check_tank binding_clauses. End by calling final_answer with a summary, cited rule IDs, and window indices. Do not answer in ordinary text.`;

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
  // Mechanical edits made before the guard ran (an unfinished sentence removed, typographic spaces).
  notes?: string[];
};

export type AgentTraceEntry = AgentModelTrace | AgentToolTrace | AgentGuardTrace;

export type AgentRunResult = {
  answer: FinalAnswerArgs | null;
  // Set only when every model answer failed the guard and check_tank had returned a result.
  plannerSummary?: string | null;
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

// What the planner on the page is showing, so the agent checks the same field, tank, job length and
// forecast instead of guessing them.
export type AgentPageContext = {
  field: string;
  products: string[];
  jobHours: number;
  forecast: "live" | "recorded";
};

// Lightning followed the page's 3-hour job even when the question said "a 4-hour job", so a field
// or job length named in the question replaces the page's value here, in code.
function fieldNamedIn(question: string): string | undefined {
  const text = question.toLowerCase();
  return FIELD_KEYS.find((key) => new RegExp(`\\b${key.replace("_", "[ _-]")}\\b`).test(text));
}

function jobHoursNamedIn(question: string): number | undefined {
  const match = question.match(/\b(\d{1,2})[\s-]*(?:hours?|hrs?)\b/i);
  const hours = match ? Number(match[1]) : NaN;
  return Number.isInteger(hours) && hours >= 1 && hours <= 12 ? hours : undefined;
}

export function questionWithContext(question: string, context?: AgentPageContext): string {
  if (!context) return question;
  const field = fieldNamedIn(question) ?? context.field;
  const jobHours = jobHoursNamedIn(question) ?? context.jobHours;
  const line = `Page context: field ${field}; products ${context.products.join(", ")}; job length ${jobHours} hours; forecast ${context.forecast}.`;
  return `${question}\n\n${line}`;
}

export async function runAgentLoop(
  question: string,
  onStatus?: (status: string) => void,
  context?: AgentPageContext,
): Promise<AgentRunResult> {
  const messages: AgentMessage[] = [{ role: "user", content: questionWithContext(question, context) }];
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
    const request = () => fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    let response = await request();
    // Token Factory sometimes stalls on a longer conversation and the route gives up at 25 s with a
    // 504 (2026-10-20 04:30 UTC, production and local alike). One retry of the same step is cheap.
    if (response.status === 504) {
      onStatus?.(`Calling Nemotron, model step ${callIndex + 1} of ${MAX_MODEL_CALLS} (Token Factory was slow, trying once more)`);
      response = await request();
    }
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
        const prepared = prepareFinalAnswer(executed.result as FinalAnswerArgs);
        const answer = prepared.answer;
        const checked = guardFinalAnswer(answer, toolResults);
        const guard: AgentGuardTrace = prepared.notes.length > 0
          ? { type: "guard", ...checked, notes: prepared.notes }
          : { type: "guard", ...checked };
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
    const latest = [...toolResults].reverse().find((entry) => entry.name === "check_tank")?.result;
    return {
      answer: null,
      plannerSummary: latest ? plannerSummary(latest as AgentCheckTankResult) : null,
      fallbackText: `The answer failed the final-answer check (${lastGuard.reasons.join(" ")}), so it is not shown. Here is what the tools returned.\n\n${JSON.stringify(toolResults, null, 2)}`,
      guard: lastGuard,
      trace,
      latestCheck: runtime.latestCheck,
      totalCostUsd,
    };
  }
  throw new Error(`Nemotron did not call final_answer within ${MAX_MODEL_CALLS} model calls.`);
}

// Written from the planner result alone, with no model text, for the case where every Nemotron
// answer failed the guard. It states what check_tank returned and nothing else.
export function plannerSummary(result: AgentCheckTankResult): string {
  const where = `${result.field}, ${result.job_hours}-hour job, ${result.source.kind.toLowerCase()} forecast fetched ${result.source.time}`;
  if (result.windows.length > 0) {
    return `Forecast-permitted windows (${where}): ${result.windows.map((window) => `window ${window.index}, ${window.label}`).join("; ")}. Field checks required by the label remain your responsibility.`;
  }
  const clauses = result.binding_clauses.slice(0, 3).map((clause) => `${clause.rule_id} (${clause.product}): "${clause.quote}"`);
  return `No forecast-permitted window (${where}).${clauses.length > 0 ? ` First clauses that blocked or flagged hours: ${clauses.join("; ")}` : ""}`;
}
