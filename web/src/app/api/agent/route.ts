import { NextRequest, NextResponse } from "next/server";
import { AGENT_SYSTEM_PROMPT } from "@/lib/agent/loop";
import { AGENT_TOOL_DEFINITIONS, AGENT_TOOL_NAMES } from "@/lib/agent/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = "nvidia/Nemotron-3_5-Lightning";
const ENDPOINT = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const MAX_MESSAGES = 14;
const MAX_MESSAGE_CHARACTERS = 24_000;
const MAX_TOKENS = 700;
const UPSTREAM_TIMEOUT_MS = 25_000;
const RATE_LIMIT_COUNT = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DAILY_TOKEN_BUDGET = 2_000_000;

// Token Factory price list, read 2026-10-04.
const TOKEN_FACTORY_PRICING = { inputPerMillionUsd: 0.06, outputPerMillionUsd: 0.24 } as const;

type ValidMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

// These counters are best effort per Node instance. They are not shared across Vercel instances.
const requestTimesByIp = new Map<string, number[]>();
let budgetDay = new Date().toISOString().slice(0, 10);
let tokensUsedToday = 0;

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error, status }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMessages(body: unknown): { messages?: ValidMessage[]; error?: string } {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "messages")) {
    return { error: "The request body must contain only messages." };
  }
  if (!Array.isArray(body.messages)) return { error: "messages must be an array." };
  if (body.messages.length === 0) return { error: "messages must not be empty." };
  if (body.messages.length > MAX_MESSAGES) return { error: `messages may contain at most ${MAX_MESSAGES} entries.` };
  if (body.messages.reduce((count, message) => count + JSON.stringify(message).length, 0) > MAX_MESSAGE_CHARACTERS) {
    return { error: `messages may contain at most ${MAX_MESSAGE_CHARACTERS.toLocaleString("en-US")} characters in total.` };
  }

  const supportedTools = new Set<string>(AGENT_TOOL_NAMES);
  const messages: ValidMessage[] = [];
  for (const candidate of body.messages) {
    if (!isRecord(candidate) || !["user", "assistant", "tool"].includes(String(candidate.role))) {
      return { error: "Each message must use the user, assistant, or tool role." };
    }
    if (!(typeof candidate.content === "string" || candidate.content === null)) {
      return { error: "Each message content must be a string or null." };
    }
    if (candidate.role === "assistant" && candidate.tool_calls !== undefined) {
      if (!Array.isArray(candidate.tool_calls)) return { error: "assistant tool_calls must be an array." };
      for (const call of candidate.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string" || !supportedTools.has(call.function.name)) {
          return { error: "A message requested an unknown tool." };
        }
        if (typeof call.id !== "string" || call.type !== "function" || typeof call.function.arguments !== "string") {
          return { error: "A tool call is malformed." };
        }
      }
    }
    if (candidate.role === "tool") {
      if (typeof candidate.tool_call_id !== "string" || typeof candidate.name !== "string") {
        return { error: "Tool messages require tool_call_id and name." };
      }
      if (!supportedTools.has(candidate.name)) return { error: "A message requested an unknown tool." };
    }
    messages.push(candidate as ValidMessage);
  }
  return { messages };
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function isRateLimited(ip: string, now: number): boolean {
  const recent = (requestTimesByIp.get(ip) ?? []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_COUNT) {
    requestTimesByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  requestTimesByIp.set(ip, recent);
  return false;
}

function resetBudgetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    tokensUsedToday = 0;
  }
}

function hasSuccessfulToolResult(messages: ValidMessage[], name: string): boolean {
  return messages.some((message) => {
    if (message.role !== "tool" || message.name !== name || typeof message.content !== "string") return false;
    try {
      const result = JSON.parse(message.content) as unknown;
      return !(isRecord(result) && typeof result.error === "string");
    } catch {
      return false;
    }
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    return errorResponse("The request body is not valid JSON.", 400);
  }
  const validated = validateMessages(body);
  if (!validated.messages) return errorResponse(validated.error ?? "The request is invalid.", 400);

  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) return errorResponse("The model is not configured on this deployment", 503);

  const now = Date.now();
  if (isRateLimited(clientIp(request), now)) return errorResponse("Rate limited. Try again later.", 429);
  resetBudgetIfNeeded();
  if (tokensUsedToday >= DAILY_TOKEN_BUDGET) return errorResponse("The daily model token budget is exhausted.", 429);

  const firstQuestion = validated.messages.find((message) => message.role === "user")?.content ?? "";
  const hasCheck = hasSuccessfulToolResult(validated.messages, "check_tank");
  const asksForWindows = /\bwhen\b|\bwindows?\b/i.test(firstQuestion);
  const allowedToolNames = !hasCheck
    ? new Set(["check_tank"])
    : asksForWindows
      ? new Set(["final_answer"])
      : new Set(["get_clause", "final_answer"]);
  const allowedTools = AGENT_TOOL_DEFINITIONS.filter((tool) => allowedToolNames.has(tool.function.name));
  const toolChoice = allowedTools.length === 1
    ? { type: "function", function: { name: allowedTools[0].function.name } }
    : "required";

  const started = performance.now();
  let upstream: Response;
  try {
    upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: AGENT_SYSTEM_PROMPT }, ...validated.messages],
        tools: allowedTools,
        tool_choice: toolChoice,
        parallel_tool_calls: false,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Token Factory did not respond within 25 seconds."
      : "Token Factory could not be reached.";
    return errorResponse(message, 504);
  }

  if (!upstream.ok) {
    if (upstream.status === 402) return errorResponse("Token Factory credit is exhausted", 402);
    if (upstream.status === 429) return errorResponse("Rate limited. Try again later.", 429);
    return errorResponse(`Token Factory request failed with HTTP ${upstream.status}.`, upstream.status >= 500 ? 502 : upstream.status);
  }

  let payload: unknown;
  try {
    payload = await upstream.json() as unknown;
  } catch {
    return errorResponse("Token Factory returned a response that was not JSON.", 502);
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || !isRecord(payload.choices[0].message)) {
    return errorResponse("Token Factory returned no assistant message.", 502);
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;
  tokensUsedToday += totalTokens;
  const costUsd = inputTokens / 1_000_000 * TOKEN_FACTORY_PRICING.inputPerMillionUsd
    + outputTokens / 1_000_000 * TOKEN_FACTORY_PRICING.outputPerMillionUsd;
  const upstreamMessage = payload.choices[0].message;
  const message = { ...upstreamMessage };
  if ("tool_calls" in message) {
    if (message.tool_calls === null) delete message.tool_calls;
    else if (Array.isArray(message.tool_calls)) message.tool_calls = message.tool_calls.slice(0, 1);
    else return errorResponse("Token Factory returned malformed tool calls.", 502);
  }

  return NextResponse.json({
    message,
    usage: { inputTokens, outputTokens, totalTokens },
    model: MODEL,
    latencyMs: Math.round(performance.now() - started),
    costUsd,
    finishReason: typeof payload.choices[0].finish_reason === "string" ? payload.choices[0].finish_reason : null,
    requestId: upstream.headers.get("x-request-id"),
  });
}
