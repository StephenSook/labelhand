export const AGENT_MODEL = "nvidia/Nemotron-3_5-Lightning";
export const TOKEN_FACTORY_ENDPOINT = "https://api.tokenfactory.nebius.com/v1/chat/completions";
export const TOKEN_FACTORY_PRICING = { inputPerMillionUsd: 0.06, outputPerMillionUsd: 0.24 } as const;

export type TokenFactoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

export type TokenFactoryCompletion = {
  message: TokenFactoryMessage;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  latencyMs: number;
  costUsd: number;
  finishReason: string | null;
  requestId: string | null;
};

export class TokenFactoryRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function requestTokenFactoryCompletion(input: {
  apiKey: string;
  systemPrompt: string;
  messages: TokenFactoryMessage[];
  tools: readonly unknown[];
  toolChoice: unknown;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<TokenFactoryCompletion> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 25_000;
  const started = performance.now();
  let upstream: Response;
  try {
    upstream = await fetchImpl(TOKEN_FACTORY_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        messages: [{ role: "system", content: input.systemPrompt }, ...input.messages],
        tools: input.tools,
        tool_choice: input.toolChoice,
        parallel_tool_calls: false,
        max_tokens: input.maxTokens ?? 700,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? `Token Factory did not respond within ${timeoutMs} milliseconds.`
      : "Token Factory could not be reached.";
    throw new TokenFactoryRequestError(message, 504);
  }

  if (!upstream.ok) {
    if (upstream.status === 402) throw new TokenFactoryRequestError("Token Factory credit is exhausted", 402);
    if (upstream.status === 429) throw new TokenFactoryRequestError("Rate limited. Try again later.", 429);
    throw new TokenFactoryRequestError(
      `Token Factory request failed with HTTP ${upstream.status}.`,
      upstream.status >= 500 ? 502 : upstream.status,
    );
  }

  let payload: unknown;
  try {
    payload = await upstream.json() as unknown;
  } catch {
    throw new TokenFactoryRequestError("Token Factory returned a response that was not JSON.", 502);
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || !isRecord(payload.choices[0].message)) {
    throw new TokenFactoryRequestError("Token Factory returned no assistant message.", 502);
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;
  const costUsd = inputTokens / 1_000_000 * TOKEN_FACTORY_PRICING.inputPerMillionUsd
    + outputTokens / 1_000_000 * TOKEN_FACTORY_PRICING.outputPerMillionUsd;

  return {
    message: payload.choices[0].message as TokenFactoryMessage,
    inputTokens,
    outputTokens,
    totalTokens,
    model: AGENT_MODEL,
    latencyMs: Math.round(performance.now() - started),
    costUsd,
    finishReason: typeof payload.choices[0].finish_reason === "string" ? payload.choices[0].finish_reason : null,
    requestId: upstream.headers.get("x-request-id"),
  };
}
