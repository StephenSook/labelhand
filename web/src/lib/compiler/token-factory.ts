import spec from "./spec.generated.json";

export const TOKEN_FACTORY_ENDPOINT = "https://api.tokenfactory.nebius.com/v1/chat/completions";
export const UPSTREAM_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const FIRST_PASS_MODEL = spec.MODELS.first_pass;

const NO_RETRY_STATUSES = new Set([400, 401, 402, 403]);

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface TokenFactoryOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  onUsage?: (usage: TokenUsage, requestId: string | null) => void;
}

export interface StrictJsonRequest {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  maxTokens: number;
}

export interface StrictJsonResult<T> {
  value: T;
  usage: TokenUsage;
  requestId: string | null;
  finishReason: string | null;
}

export type PageCompileResult =
  | {
      ok: true;
      page: number;
      rules: Array<Record<string, unknown>>;
      usage: TokenUsage;
      requestIds: string[];
      splits: number;
      latencyMs: number;
    }
  | {
      ok: false;
      page: number;
      rules: [];
      usage: TokenUsage;
      requestIds: string[];
      splits: number;
      latencyMs: number;
      error: string;
      status?: number;
    };

export class TokenFactoryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TokenFactoryError";
  }
}

export class TruncatedResponse extends Error {
  constructor(readonly usage: TokenUsage, readonly requestId: string | null) {
    super("Token Factory response reached max_tokens.");
    this.name = "TruncatedResponse";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFor(model: string, value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  const inputTokens = numberOrZero(usage.prompt_tokens);
  const outputTokens = numberOrZero(usage.completion_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || inputTokens + outputTokens;
  const prices = (spec.PRICES as Record<string, number[]>)[model];
  if (!prices || prices.length !== 2) throw new TokenFactoryError(`No Token Factory price is recorded for model ${model}.`);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: inputTokens / 1_000_000 * prices[0] + outputTokens / 1_000_000 * prices[1],
  };
}

export function mergeUsage(...items: TokenUsage[]): TokenUsage {
  return items.reduce<TokenUsage>((total, item) => ({
    inputTokens: total.inputTokens + item.inputTokens,
    outputTokens: total.outputTokens + item.outputTokens,
    totalTokens: total.totalTokens + item.totalTokens,
    costUsd: total.costUsd + item.costUsd,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function throwIfTokenFactoryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new TokenFactoryError("Token Factory request was cancelled.");
}

export async function callStrictJson<T>(
  request: StrictJsonRequest,
  options: TokenFactoryOptions,
): Promise<StrictJsonResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: TokenFactoryError = new TokenFactoryError("Token Factory request failed.");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    throwIfTokenFactoryAborted(options.signal);
    try {
      const response = await fetchImpl(TOKEN_FACTORY_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          temperature: 0,
          max_tokens: request.maxTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: request.schemaName, schema: request.schema, strict: true },
          },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: requestSignal(options.signal),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        const error = new TokenFactoryError(
          `Token Factory returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
          response.status,
        );
        if (NO_RETRY_STATUSES.has(response.status)) throw error;
        lastError = error;
      } else {
        const payload = await response.json() as unknown;
        const usage = usageFor(request.model, isRecord(payload) ? payload.usage : null);
        const requestId = response.headers.get("x-request-id");
        options.onUsage?.(usage, requestId);
        throwIfTokenFactoryAborted(options.signal);
        if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
          throw new TokenFactoryError("Token Factory returned no completion choice.");
        }
        const choice = payload.choices[0];
        if (choice.finish_reason === "length") throw new TruncatedResponse(usage, requestId);
        if (!isRecord(choice.message) || typeof choice.message.content !== "string") {
          throw new TokenFactoryError("Token Factory returned no JSON message content.");
        }
        return {
          value: JSON.parse(choice.message.content) as T,
          usage,
          requestId,
          finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
        };
      }
    } catch (error) {
      throwIfTokenFactoryAborted(options.signal);
      if (error instanceof TruncatedResponse) throw error;
      if (error instanceof TokenFactoryError && error.status !== undefined && NO_RETRY_STATUSES.has(error.status)) {
        throw error;
      }
      lastError = error instanceof TokenFactoryError
        ? error
        : new TokenFactoryError(error instanceof Error ? `${error.name}: ${error.message}` : "Token Factory request failed.");
    }
    if (attempt + 1 < MAX_ATTEMPTS) await sleep(2_000 + 4_000 * attempt);
  }
  throw lastError;
}

export function splitText(text: string): [string, string] {
  const middle = Math.floor(text.length / 2);
  let cut = text.lastIndexOf("\n", middle);
  if (cut < text.length / 4) cut = text.indexOf("\n", middle);
  if (cut < 0) cut = middle;
  return [text.slice(0, cut), text.slice(cut)];
}

export async function compilePage(
  page: number,
  text: string,
  options: TokenFactoryOptions,
  depth = 0,
): Promise<PageCompileResult> {
  throwIfTokenFactoryAborted(options.signal);
  const started = performance.now();
  try {
    const result = await callStrictJson<{ rules?: unknown }>(
      {
        model: FIRST_PASS_MODEL,
        system: spec.PROMPTS.first_pass,
        user: `PAGE ${page} TEXT:\n${text}`,
        schemaName: "label_rules",
        schema: spec.SCHEMAS.first_pass,
        maxTokens: 6_000,
      },
      options,
    );
    const rules = isRecord(result.value) && Array.isArray(result.value.rules)
      ? result.value.rules.filter(isRecord)
      : [];
    return {
      ok: true,
      page,
      rules,
      usage: result.usage,
      requestIds: result.requestId ? [result.requestId] : [],
      splits: depth,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    throwIfTokenFactoryAborted(options.signal);
    if (error instanceof TruncatedResponse && depth < 2) {
      const halves = await Promise.all(splitText(text).map((part) => compilePage(page, part, options, depth + 1)));
      const requestIds = [
        ...(error.requestId ? [error.requestId] : []),
        ...halves.flatMap((half) => half.requestIds),
      ];
      const usage = mergeUsage(error.usage, ...halves.map((half) => half.usage));
      if (halves.every((half) => half.ok)) {
        return {
          ok: true,
          page,
          rules: halves.flatMap((half) => half.rules),
          usage,
          requestIds,
          splits: Math.max(...halves.map((half) => half.splits)),
          latencyMs: Math.round(performance.now() - started),
        };
      }
      return {
        ok: false,
        page,
        rules: [],
        usage,
        requestIds,
        splits: Math.max(...halves.map((half) => half.splits)),
        latencyMs: Math.round(performance.now() - started),
        error: halves.filter((half) => !half.ok).map((half) => half.error).join("; "),
      };
    }
    const failure = error instanceof TokenFactoryError
      ? error
      : new TokenFactoryError(error instanceof TruncatedResponse ? "Truncated after two splits." : "Token Factory request failed.");
    return {
      ok: false,
      page,
      rules: [],
      usage: error instanceof TruncatedResponse ? error.usage : mergeUsage(),
      requestIds: error instanceof TruncatedResponse && error.requestId ? [error.requestId] : [],
      splits: depth,
      latencyMs: Math.round(performance.now() - started),
      error: failure.message,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    };
  }
}
