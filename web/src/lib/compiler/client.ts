import type { CompiledLiveLabel, PipelineEvent } from "./pipeline";

const MAX_BUFFER_CHARACTERS = 2_000_000;
const EVENT_TYPES = new Set([
  "listed",
  "pdf",
  "cached",
  "extracted",
  "page",
  "typing",
  "floor",
  "heartbeat",
  "done",
  "error",
]);

export class LiveCompileClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LiveCompileClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEvent(line: string): PipelineEvent {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new LiveCompileClientError("The live compiler returned malformed NDJSON.");
  }
  if (!isRecord(value) || typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) {
    throw new LiveCompileClientError("The live compiler returned an unknown event.");
  }
  return value as PipelineEvent;
}

async function responseError(response: Response): Promise<LiveCompileClientError> {
  try {
    const body = await response.json() as unknown;
    if (isRecord(body) && typeof body.error === "string") {
      return new LiveCompileClientError(body.error, response.status);
    }
  } catch {
    // Fall through to the status message.
  }
  return new LiveCompileClientError(`The live compiler returned HTTP ${response.status}.`, response.status);
}

export async function readCompileStream(
  response: Response,
  onEvent: (event: PipelineEvent) => void | Promise<void> = () => undefined,
): Promise<CompiledLiveLabel> {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new LiveCompileClientError("The live compiler returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let compiled: CompiledLiveLabel | null = null;

  const consume = async (line: string) => {
    if (!line.trim()) return;
    const event = decodeEvent(line);
    await onEvent(event);
    if (event.type === "error") throw new LiveCompileClientError(event.reason);
    if (event.type === "cached" || event.type === "done") compiled = event.compiled;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > MAX_BUFFER_CHARACTERS) {
        throw new LiveCompileClientError("The live compiler response exceeded the client buffer limit.");
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) await consume(line);
      if (done) break;
    }
    await consume(buffer);
    if (!compiled) throw new LiveCompileClientError("The live compiler stream ended before a result arrived.");
    return compiled;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The stream may already be errored or closed.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function requestLiveCompile(
  reg: string,
  onEvent?: (event: PipelineEvent) => void | Promise<void>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CompiledLiveLabel> {
  const response = await fetchImpl("/api/labels/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reg }),
    ...(signal ? { signal } : {}),
  });
  return readCompileStream(response, onEvent);
}
