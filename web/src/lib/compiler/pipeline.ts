import type { CompiledLabel } from "@/engine";

import { guard, norm, restoreUnits } from "./guards";
import { mergeReports, type MergedRule } from "./merge-reports";
import { applyFloor, brandOf } from "./modality";
import { extractPdfText, PDFJS_VERSION, quoteIsPresent, readableTextGate } from "./pdf-text";
import spec from "./spec.generated.json";
import {
  compilePage,
  FIRST_PASS_MODEL,
  mergeUsage,
  type TokenFactoryOptions,
  type TokenUsage,
} from "./token-factory";
import {
  applyTyping,
  hasTopicWord,
  keepFirstPass,
  TYPING_MODEL,
  type CompilerRule,
  typeRule,
} from "./typing";
import { COMPILE_TOKEN_CEILING, LIVE_COMPILE_READINGS } from "../live-limits";
import {
  MAX_PDF_BYTES,
  MIN_PDF_BYTES,
  parsePplsFileName,
  pplsPdfUrl,
  sha256,
} from "../ppls";

export const PIPELINE_VERSION = [
  `prompt-${spec.VERSIONS.prompt}`,
  `typing-${spec.VERSIONS.typing}`,
  "floor-pr-notice-2000-5-v1",
  `first-${FIRST_PASS_MODEL.split("/").at(-1)}`,
  `type-${TYPING_MODEL.split("/").at(-1)}`,
  `pdfjs-${PDFJS_VERSION}`,
  `live-readings-${LIVE_COMPILE_READINGS}-merge-v1`,
].join("_");

const KINDS = new Set(["forecast_series", "solar_window", "geometry_buffer", "counter", "field_obligation"]);
const MODALITIES = new Set(["MUST", "MUST_NOT", "ADVISORY"]);
const OPERATORS = new Set(["lt", "lte", "gt", "gte", "eq", "between", "none"]);
const PARAMETERS = new Set<string>(spec.PARAMS);
const CODE_NAME = /^[a-z]{1,5}-?\d/i;
// The phrase EPA requires on a restricted-use label's front panel, read from the same page text the
// compiler uses. The three shipped labels were classified by the same phrase (lib/label-restrictions.ts).
const RESTRICTED_USE = /RESTRICTED\s+USE\s+PESTICIDE/i;

export function hasRestrictedUsePhrase(pages: string[]): boolean {
  return pages.some((text) => RESTRICTED_USE.test(text));
}

export interface LiveCompileInput {
  reg: string;
  product: string;
  alternateBrandNames: string[];
  searchedName?: string;
  fileName: string;
  accepted: string;
  labelUrl: string;
  labelSha256: string;
  pdfBytes: Uint8Array;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface RejectedCompilerRule extends Record<string, unknown> {
  id: string;
  page: number;
  quote: string;
  reject_reason: string;
}

interface ReadingReport extends CompiledLabel {
  reg: string;
  product: string;
  label_accepted: string;
  label_sha256: string;
  label_url: string;
  label_file: string;
  model: string;
  retype_model: string;
  pipeline_version: string;
  extractor: string;
  compiled_utc: string;
  scored: false;
  restricted_use: boolean;
  complete: boolean;
  pages: number;
  failed_pages: Array<{ page: number; error: string; status?: number }>;
  typing_failures: Array<{ id: string; error: string; status?: number }>;
  tokens_in: number;
  tokens_out: number;
  total_tokens: number;
  cost_usd: number;
  request_ids: string[];
  accepted: CompilerRule[];
  rejected: RejectedCompilerRule[];
}

export interface LiveReadingRecord {
  reading: number;
  attempts: number;
  accepted_rules: number;
  rejected_rules: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  total_tokens: number;
  cost_usd: number;
  request_ids: string[];
}

export interface CompiledLiveLabel extends ReadingReport {
  readings: number;
  reading_records: LiveReadingRecord[];
  latency_ms: number;
  merged_from: string[];
  accepted: Array<MergedRule<CompilerRule>>;
}

export type PipelineEvent =
  | { type: "listed"; reg: string; product: string; fileName: string; accepted: string }
  | { type: "pdf"; bytes: number; sha256: string; accepted: string }
  | { type: "cached"; compiled: CompiledLiveLabel }
  | { type: "extracted"; pages: number }
  | { type: "page"; n: number; of: number; accepted: number; rejected: number; reading?: number; attempt?: number }
  | { type: "typing"; done: number; of: number; reading?: number; attempt?: number }
  | { type: "floor"; raised: number; reading?: number; attempt?: number }
  | { type: "heartbeat" }
  | { type: "done"; compiled: CompiledLiveLabel }
  | { type: "error"; reason: string };

export type PipelineEmitter = (event: PipelineEvent) => void | Promise<void>;

export class PipelineError extends Error {
  usage?: TokenUsage;
  requestIds: string[];

  constructor(
    message: string,
    readonly status = 422,
    usage?: TokenUsage,
    requestIds: string[] = [],
  ) {
    super(message);
    this.name = "PipelineError";
    this.usage = usage;
    this.requestIds = requestIds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function decodeRule(raw: unknown, page: number, id: string): CompilerRule | null {
  if (!isRecord(raw)) return null;
  if (!KINDS.has(String(raw.kind))
    || !MODALITIES.has(String(raw.modality))
    || !PARAMETERS.has(String(raw.param))
    || !OPERATORS.has(String(raw.op))
    || !numericOrNull(raw.value)
    || !numericOrNull(raw.value2)
    || !(raw.unit === null || typeof raw.unit === "string")
    || typeof raw.applies_to !== "string"
    || typeof raw.summary !== "string"
    || typeof raw.quote !== "string") {
    return null;
  }
  return {
    kind: raw.kind,
    modality: raw.modality as string,
    param: raw.param as string,
    op: raw.op as string,
    value: raw.value,
    value2: raw.value2,
    unit: raw.unit,
    applies_to: raw.applies_to,
    summary: raw.summary,
    quote: raw.quote,
    page,
    id,
  };
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  completed?: (result: R, index: number, done: number) => Promise<void>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const result = await work(items[index], index);
      results[index] = result;
      done += 1;
      if (completed) await completed(result, index, done);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof PipelineError) throw signal.reason;
  throw new PipelineError("The live compile deadline was reached.", 504);
}

function fatalTokenFactoryError(status?: number): PipelineError | null {
  if (status === 402) return new PipelineError("Token Factory credit is exhausted.", 503);
  if (status === 429) return new PipelineError("Token Factory is busy. Try again shortly.", 429);
  if (status === 400) return new PipelineError("Token Factory rejected the compiler request.", 502);
  if (status === 401 || status === 403) return new PipelineError("Token Factory credentials are unavailable.", 503);
  return null;
}

function verifyPdf(input: LiveCompileInput): void {
  parsePplsFileName(input.fileName, input.reg);
  if (input.labelUrl !== pplsPdfUrl(input.fileName)) {
    throw new PipelineError("The EPA label URL did not use the fixed PPLS PDF host.");
  }
  if (input.pdfBytes.byteLength < MIN_PDF_BYTES || input.pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new PipelineError(`The EPA label PDF size ${input.pdfBytes.byteLength} is outside the live compile limits.`);
  }
  if (new TextDecoder("ascii").decode(input.pdfBytes.subarray(0, 5)) !== "%PDF-") {
    throw new PipelineError("The EPA label response did not have the %PDF- signature.");
  }
  if (sha256(input.pdfBytes) !== input.labelSha256) {
    throw new PipelineError("The EPA label PDF SHA-256 changed before compile.");
  }
}

function selectBrand(input: LiveCompileInput): string | null {
  const searched = input.searchedName?.trim();
  if (searched && searched !== input.reg) return brandOf(searched);
  if (CODE_NAME.test(input.product)) {
    const alternate = input.alternateBrandNames.find(Boolean);
    if (alternate) return brandOf(alternate);
  }
  return brandOf(input.product);
}

export function assertCompiledShape(
  compiled: Pick<ReadingReport, "restricted_use" | "accepted">,
  pages: string[],
): void {
  if (typeof compiled.restricted_use !== "boolean") {
    throw new PipelineError("Compiled label has no restricted-use classification.");
  }
  for (const rule of compiled.accepted) {
    if (!rule.id
      || !Number.isInteger(rule.page)
      || rule.page < 1
      || rule.page > pages.length
      || !PARAMETERS.has(rule.param)
      || !OPERATORS.has(rule.op)
      || !MODALITIES.has(rule.modality)
      || !numericOrNull(rule.value)
      || !numericOrNull(rule.value2)
      || !rule.quote
      || !quoteIsPresent(pages[rule.page - 1], rule.quote)) {
      throw new PipelineError(`Compiled rule ${rule.id || "without an id"} failed the cache shape check.`);
    }
  }
}

interface ReadingResult {
  report: ReadingReport;
  record: LiveReadingRecord;
}

type BilledUsageListener = (usage: TokenUsage, requestId: string | null) => void;

function asPipelineError(error: unknown, fallback: string): PipelineError {
  if (error instanceof PipelineError) return error;
  return new PipelineError(error instanceof Error ? error.message : fallback, 502);
}

function incompleteReadingReason(report: ReadingReport): string {
  const pageCount = report.failed_pages.length;
  const typingCount = report.typing_failures.length;
  return `${pageCount} page call${pageCount === 1 ? "" : "s"} and ${typingCount} typing call${typingCount === 1 ? "" : "s"} failed.`;
}

async function compileReadingAttempt(
  input: LiveCompileInput,
  pages: string[],
  reading: number,
  attempt: number,
  priorReadingTokens: number,
  signal: AbortSignal,
  onBilled: BilledUsageListener,
  emit: PipelineEmitter,
): Promise<ReadingReport> {
  if (priorReadingTokens >= COMPILE_TOKEN_CEILING) {
    throw new PipelineError(`The live compile exceeded the ${COMPILE_TOKEN_CEILING} token ceiling.`, 422);
  }
  const compileAbort = new AbortController();
  let usage = mergeUsage();
  const billedRequestIds: string[] = [];
  let terminalError: PipelineError | undefined;
  const updateErrorUsage = (error: PipelineError) => {
    error.usage = usage;
    error.requestIds = [...billedRequestIds];
  };
  const abortCompile = (error: PipelineError): PipelineError => {
    terminalError = error;
    updateErrorUsage(error);
    if (!compileAbort.signal.aborted) compileAbort.abort(error);
    return error;
  };
  const abortFromParent = () => {
    const reason = signal.reason;
    abortCompile(reason instanceof PipelineError
      ? new PipelineError(reason.message, reason.status)
      : new PipelineError("The live compile deadline was reached.", 504));
  };
  if (signal.aborted) abortFromParent();
  else signal.addEventListener("abort", abortFromParent, { once: true });
  const compileSignal = compileAbort.signal;
  const tokenOptions: TokenFactoryOptions = {
    apiKey: input.apiKey,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    signal: compileSignal,
    onUsage: (item, requestId) => {
      usage = mergeUsage(usage, item);
      if (requestId) billedRequestIds.push(requestId);
      onBilled(item, requestId);
      if (terminalError) updateErrorUsage(terminalError);
      if (priorReadingTokens + usage.totalTokens > COMPILE_TOKEN_CEILING) {
        abortCompile(new PipelineError(
          `The live compile exceeded the ${COMPILE_TOKEN_CEILING} token ceiling.`,
          422,
        ));
      }
    },
  };
  const pageInputs = pages.map((text, index) => ({ page: index + 1, text }));
  const accepted: CompilerRule[] = [];
  const rejected: RejectedCompilerRule[] = [];
  const failedPages: Array<{ page: number; error: string; status?: number }> = [];
  try {
    await mapConcurrent(
      pageInputs,
      8,
      ({ page, text }) => compilePage(page, text, tokenOptions),
      async (result) => {
        if (!result.ok) {
          const fatal = fatalTokenFactoryError(result.status);
          if (fatal) throw abortCompile(fatal);
          failedPages.push({
            page: result.page,
            error: result.error,
            ...(result.status === undefined ? {} : { status: result.status }),
          });
          await emit({
            type: "page",
            n: result.page,
            of: pages.length,
            accepted: 0,
            rejected: 0,
            reading,
            attempt,
          });
          return;
        }
        const pageText = norm(pages[result.page - 1]);
        let acceptedOnPage = 0;
        let rejectedOnPage = 0;
        for (let index = 0; index < result.rules.length; index += 1) {
          const id = `${input.reg}-p${result.page}-${index + 1}`;
          const rawRule = result.rules[index];
          const decoded = decodeRule(rawRule, result.page, id);
          if (!decoded) {
            rejected.push({
              id,
              page: result.page,
              quote: isRecord(rawRule) && typeof rawRule.quote === "string" ? rawRule.quote : "",
              reject_reason: "SCHEMA_INVALID",
            });
            rejectedOnPage += 1;
            continue;
          }
          const restored = restoreUnits(decoded);
          const reason = guard(restored, pageText);
          if (reason) {
            rejected.push({ ...restored, reject_reason: reason });
            rejectedOnPage += 1;
          } else {
            accepted.push(restored);
            acceptedOnPage += 1;
          }
        }
        await emit({
          type: "page",
          n: result.page,
          of: pages.length,
          accepted: acceptedOnPage,
          rejected: rejectedOnPage,
          reading,
          attempt,
        });
      },
    );
    accepted.sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
    rejected.sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
    failedPages.sort((left, right) => left.page - right.page);
    throwIfAborted(compileSignal);

    const topical = accepted.filter(hasTopicWord);
    const typingFailures: Array<{ id: string; error: string; status?: number }> = [];
    const typed = await mapConcurrent(
      topical,
      6,
      async (rule) => {
        const result = await typeRule(rule, tokenOptions);
        if (!result.ok) {
          const fatal = fatalTokenFactoryError(result.status);
          if (fatal) throw abortCompile(fatal);
        }
        return { rule, result };
      },
      async (_result, _index, done) => emit({
        type: "typing",
        done,
        of: topical.length,
        reading,
        attempt,
      }),
    );
    if (topical.length === 0) {
      await emit({ type: "typing", done: 0, of: 0, reading, attempt });
    }
    const typedById = new Map<string, CompilerRule>();
    for (const { rule, result } of typed) {
      if (!result.ok) {
        typingFailures.push({
          id: rule.id,
          error: result.error,
          ...(result.status === undefined ? {} : { status: result.status }),
        });
        typedById.set(rule.id, { ...keepFirstPass(rule), typing_error: result.error });
        continue;
      }
      typedById.set(rule.id, applyTyping(rule, result.typed));
    }
    const typedRules = accepted.map((rule) => typedById.get(rule.id) ?? keepFirstPass(rule));

    const brand = selectBrand(input);
    const floored = typedRules.map((rule) => applyFloor(rule, pages, brand));
    const raised = floored.filter((rule) => "modality_floor" in rule).length;
    await emit({ type: "floor", raised, reading, attempt });

    const compiled: ReadingReport = {
      reg: input.reg,
      product: input.product,
      label_accepted: input.accepted,
      label_sha256: input.labelSha256,
      label_url: input.labelUrl,
      label_file: input.fileName,
      model: FIRST_PASS_MODEL,
      retype_model: TYPING_MODEL,
      pipeline_version: PIPELINE_VERSION,
      extractor: `pdfjs-${PDFJS_VERSION}`,
      compiled_utc: (input.now?.() ?? new Date()).toISOString(),
      scored: false,
      restricted_use: hasRestrictedUsePhrase(pages),
      complete: failedPages.length === 0 && typingFailures.length === 0,
      pages: pages.length,
      failed_pages: failedPages,
      typing_failures: typingFailures,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
      total_tokens: usage.totalTokens,
      cost_usd: usage.costUsd,
      request_ids: billedRequestIds,
      accepted: floored,
      rejected,
    };
    assertCompiledShape(compiled, pages);
    return compiled;
  } catch (error) {
    if (error instanceof PipelineError) updateErrorUsage(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", abortFromParent);
  }
}

async function compileReadingWithRetry(
  input: LiveCompileInput,
  pages: string[],
  reading: number,
  signal: AbortSignal,
  onBilled: BilledUsageListener,
  emit: PipelineEmitter,
): Promise<ReadingResult> {
  const started = performance.now();
  let usage = mergeUsage();
  const requestIds: string[] = [];
  let lastError: PipelineError | undefined;
  let lastReport: ReadingReport | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    throwIfAborted(signal);
    try {
      // Every reading streams its own progress, tagged with its reading and attempt, so the page
      // can show three readings advance side by side and restart a reading's count on a retry.
      const report = await compileReadingAttempt(
        input,
        pages,
        reading,
        attempt,
        usage.totalTokens,
        signal,
        (item, requestId) => {
          usage = mergeUsage(usage, item);
          if (requestId) requestIds.push(requestId);
          onBilled(item, requestId);
        },
        emit,
      );
      lastReport = report;
      if (report.complete) {
        const completeReport: ReadingReport = {
          ...report,
          tokens_in: usage.inputTokens,
          tokens_out: usage.outputTokens,
          total_tokens: usage.totalTokens,
          cost_usd: usage.costUsd,
          request_ids: [...requestIds],
        };
        return {
          report: completeReport,
          record: {
            reading,
            attempts: attempt,
            accepted_rules: report.accepted.length,
            rejected_rules: report.rejected.length,
            latency_ms: Math.round(performance.now() - started),
            tokens_in: usage.inputTokens,
            tokens_out: usage.outputTokens,
            total_tokens: usage.totalTokens,
            cost_usd: usage.costUsd,
            request_ids: [...requestIds],
          },
        };
      }
      lastError = new PipelineError(incompleteReadingReason(report));
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      lastError = asPipelineError(error, `Live label reading ${reading} failed.`);
    }
  }

  const detail = lastError?.message ?? (lastReport ? incompleteReadingReason(lastReport) : "Unknown reading failure.");
  throw new PipelineError(
    `Live label reading ${reading} failed after one retry: ${detail}`,
    lastError?.status ?? 422,
    usage,
    requestIds,
  );
}

export async function compileLiveLabel(
  input: LiveCompileInput,
  emit: PipelineEmitter = () => undefined,
): Promise<CompiledLiveLabel> {
  const started = performance.now();
  throwIfAborted(input.signal);
  verifyPdf(input);
  await emit({ type: "pdf", bytes: input.pdfBytes.byteLength, sha256: input.labelSha256, accepted: input.accepted });

  const extracted = await extractPdfText(input.pdfBytes);
  const readable = readableTextGate(extracted.pages);
  if (!readable.ok) throw new PipelineError(readable.reason);
  await emit({ type: "extracted", pages: extracted.pageCount });
  throwIfAborted(input.signal);

  const groupAbort = new AbortController();
  let usage = mergeUsage();
  const requestIds: string[] = [];
  let terminalError: PipelineError | undefined;
  const abortFromParent = () => {
    const reason = input.signal?.reason;
    if (!groupAbort.signal.aborted) {
      groupAbort.abort(reason instanceof Error ? reason : new PipelineError("The live compile deadline was reached.", 504));
    }
  };
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });

  const readings = Array.from({ length: LIVE_COMPILE_READINGS }, (_value, index) => index + 1);
  try {
    const results = await mapConcurrent(
      readings,
      LIVE_COMPILE_READINGS,
      async (reading) => {
        try {
          return await compileReadingWithRetry(
            input,
            extracted.pages,
            reading,
            groupAbort.signal,
            (item, requestId) => {
              usage = mergeUsage(usage, item);
              if (requestId) requestIds.push(requestId);
            },
            emit,
          );
        } catch (error) {
          const failure = asPipelineError(error, `Live label reading ${reading} failed.`);
          if (!groupAbort.signal.aborted) {
            terminalError = failure;
            groupAbort.abort(failure);
          }
          throw failure;
        }
      },
    );
    const runNames = readings.map((reading) => `reading-${reading}`);
    const merged = mergeReports<CompilerRule, ReadingReport>(
      results.map(({ report }) => report),
      runNames,
    );
    const compiled: CompiledLiveLabel = {
      ...merged,
      compiled_utc: (input.now?.() ?? new Date()).toISOString(),
      complete: true,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
      total_tokens: usage.totalTokens,
      cost_usd: usage.costUsd,
      request_ids: requestIds,
      readings: LIVE_COMPILE_READINGS,
      reading_records: results.map(({ record }) => record),
      latency_ms: Math.round(performance.now() - started),
    };
    assertCompiledShape(compiled, extracted.pages);
    await emit({ type: "done", compiled });
    return compiled;
  } catch (error) {
    const failure = terminalError ?? asPipelineError(error, "Live label compilation failed.");
    failure.usage = usage;
    failure.requestIds = [...requestIds];
    throw failure;
  } finally {
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}
