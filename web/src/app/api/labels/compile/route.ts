import { NextRequest, NextResponse } from "next/server";

import {
  compileLiveLabel,
  PIPELINE_VERSION,
  PipelineError,
  type CompiledLiveLabel,
  type PipelineEmitter,
} from "@/lib/compiler/pipeline";
import {
  getCachedLiveLabel,
  getLiveCacheIndex,
  getRegistrationCacheIndex,
  liveCacheConfigured,
  writeLiveCache,
} from "@/lib/live-cache";
import {
  assertCacheHitAllowed,
  assertColdCompileAllowed,
  assertCompileTokenCeiling,
  assertDailyBudgetAvailable,
  assertLiveCompileEnabled,
  LiveLimitError,
  recordCompileSpend,
  runColdCompile,
} from "@/lib/live-limits";
import { reserveSharedColdCompile } from "@/lib/live-ledger";
import { assertActiveRegistration, assertFederalReg, fetchLabelPdf, listLabelVersions, PplsError } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 300;

const INTERNAL_DEADLINE_MS = 150_000;
const HEARTBEAT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error, status }, { status });
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new PipelineError("The live compile request was cancelled.", 499);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new PipelineError("The live compile exceeded its deadline.", 504));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function commitLiveCache(compiled: CompiledLiveLabel, signal: AbortSignal): Promise<void> {
  const stored = await writeLiveCache(compiled, signal);
  throwIfAborted(signal);
  if (liveCacheConfigured() && !stored) {
    throw new PipelineError("The live compile finished, but its cache record could not be committed. Try again.", 503);
  }
}

function publicError(error: unknown): string {
  if (error instanceof PipelineError || error instanceof LiveLimitError || error instanceof PplsError) {
    return error.message;
  }
  return "Live label compilation failed.";
}

export async function POST(request: NextRequest) {
  try {
    assertLiveCompileEnabled();
  } catch (error) {
    if (error instanceof LiveLimitError) return errorResponse(error.message, error.status);
    return errorResponse("Live label compilation is unavailable.", 503);
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    return errorResponse("The request body is not valid JSON.", 400);
  }
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "reg") || typeof body.reg !== "string") {
    return errorResponse("The request body must contain only a registration number in reg.", 400);
  }

  let reg: string;
  try {
    reg = assertFederalReg(body.reg);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "The EPA registration number is invalid.", 400);
  }

  const ip = clientIp(request);
  try {
    assertCacheHitAllowed(ip);
  } catch (error) {
    if (error instanceof LiveLimitError) return errorResponse(error.message, error.status);
    return errorResponse("The live label request limit could not be checked.", 503);
  }

  const encoder = new TextEncoder();
  const workAbort = new AbortController();
  let streamClosed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abortForRequest = () => {
        if (!workAbort.signal.aborted) {
          workAbort.abort(new PipelineError("The live compile request was cancelled.", 499));
        }
      };
      if (request.signal.aborted) abortForRequest();
      else request.signal.addEventListener("abort", abortForRequest, { once: true });

      const send: PipelineEmitter = (event) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          streamClosed = true;
          abortForRequest();
        }
      };
      const deadline = setTimeout(() => {
        if (!workAbort.signal.aborted) {
          workAbort.abort(new PipelineError("The live compile exceeded its 150 second deadline.", 504));
        }
      }, INTERNAL_DEADLINE_MS);
      const heartbeat = setInterval(() => {
        void send({ type: "heartbeat" });
      }, HEARTBEAT_MS);

      void (async () => {
        try {
          throwIfAborted(workAbort.signal);
          const registrationIndex = await getRegistrationCacheIndex(reg, workAbort.signal);
          throwIfAborted(workAbort.signal);
          let coldRateReserved = false;
          const reserveColdPath = () => {
            if (coldRateReserved) return;
            assertDailyBudgetAvailable();
            assertColdCompileAllowed(ip);
            coldRateReserved = true;
          };
          if (!registrationIndex) reserveColdPath();

          let product;
          try {
            product = await withAbort(listLabelVersions(reg), workAbort.signal);
          } catch (error) {
            throwIfAborted(workAbort.signal);
            const availabilityFailure = error instanceof PplsError && error.status >= 500;
            if (availabilityFailure && registrationIndex?.pipelineVersion === PIPELINE_VERSION) {
              const cached = await getCachedLiveLabel(
                registrationIndex.sha256,
                PIPELINE_VERSION,
                workAbort.signal,
              );
              throwIfAborted(workAbort.signal);
              if (
                cached
                && cached.reg === reg
                && cached.label_file === registrationIndex.fileName
                && cached.label_accepted === registrationIndex.accepted
                && cached.label_url === registrationIndex.labelUrl
              ) {
                await send({
                  type: "listed",
                  reg,
                  product: registrationIndex.product,
                  fileName: registrationIndex.fileName,
                  accepted: registrationIndex.accepted,
                });
                // EPA did not answer, so assertActiveRegistration could not run. The stored compile is still
                // served (PPLS drops connections often), marked so every page that shows it can say so.
                await send({ type: "cached", compiled: { ...cached, status_unchecked: true } });
                return;
              }
            }
            throw error;
          }

          throwIfAborted(workAbort.signal);
          assertActiveRegistration(product);
          const version = product.versions[0];
          await send({
            type: "listed",
            reg,
            product: product.product,
            fileName: version.fileName,
            accepted: version.accepted,
          });

          const registrationCurrent = registrationIndex
            && registrationIndex.reg === reg
            && registrationIndex.fileName === version.fileName
            && registrationIndex.accepted === version.accepted
            && registrationIndex.labelUrl === version.url
            && registrationIndex.pipelineVersion === PIPELINE_VERSION
            ? registrationIndex
            : null;
          const index = registrationCurrent
            ? registrationCurrent
            : await getLiveCacheIndex(version.fileName, workAbort.signal);
          throwIfAborted(workAbort.signal);
          const currentIndex = index
            && index.reg === reg
            && index.fileName === version.fileName
            && index.accepted === version.accepted
            && index.labelUrl === version.url
            && index.pipelineVersion === PIPELINE_VERSION
            ? index
            : null;
          if (currentIndex) {
            const cached = await getCachedLiveLabel(currentIndex.sha256, PIPELINE_VERSION, workAbort.signal);
            throwIfAborted(workAbort.signal);
            if (
              cached
              && cached.reg === reg
              && cached.label_file === version.fileName
              && cached.label_accepted === version.accepted
              && cached.label_url === version.url
            ) {
              if (!registrationCurrent) await commitLiveCache(cached, workAbort.signal);
              await send({ type: "cached", compiled: cached });
              return;
            }
          }

          reserveColdPath();
          const pdf = await withAbort(fetchLabelPdf(version), workAbort.signal);
          throwIfAborted(workAbort.signal);
          if (currentIndex && currentIndex.sha256 !== pdf.sha256) {
            throw new PipelineError("The EPA label PDF SHA-256 no longer matches its cache index.", 502);
          }

          const racedCache = await getCachedLiveLabel(pdf.sha256, PIPELINE_VERSION, workAbort.signal);
          throwIfAborted(workAbort.signal);
          if (
            racedCache
            && racedCache.reg === reg
            && racedCache.label_file === version.fileName
            && racedCache.label_accepted === version.accepted
            && racedCache.label_url === version.url
          ) {
            if (!registrationCurrent) await commitLiveCache(racedCache, workAbort.signal);
            await send({ type: "cached", compiled: racedCache });
            return;
          }

          const apiKey = process.env.NEBIUS_API_KEY?.trim();
          if (!apiKey) throw new PipelineError("The live compiler is not configured on this deployment.", 503);

          const cold = await runColdCompile({
            sha256: pdf.sha256,
            ip,
            signal: workAbort.signal,
            coldRateReserved,
            requestRateReserved: true,
            work: async (sharedSignal) => {
              // The per-instance limits above cannot see other instances; this shared ledger can.
              await reserveSharedColdCompile({ ip, signal: sharedSignal });
              const compileSignal = AbortSignal.any([
                sharedSignal,
                AbortSignal.timeout(INTERNAL_DEADLINE_MS),
              ]);
              let spendRecorded = false;
              try {
                const emit: PipelineEmitter = async (event) => {
                  if (event.type !== "done") await send(event);
                };
                const compiled = await compileLiveLabel({
                  reg,
                  product: product.product,
                  alternateBrandNames: product.alternateBrandNames,
                  fileName: version.fileName,
                  accepted: version.accepted,
                  labelUrl: version.url,
                  labelSha256: pdf.sha256,
                  pdfBytes: pdf.bytes,
                  apiKey,
                  signal: compileSignal,
                }, emit);
                recordCompileSpend(compiled.cost_usd);
                spendRecorded = true;
                assertCompileTokenCeiling(compiled.total_tokens, compiled.readings);
                throwIfAborted(compileSignal);
                if (compiled.complete) await commitLiveCache(compiled, compileSignal);
                return compiled;
              } catch (error) {
                if (!spendRecorded && error instanceof PipelineError && error.usage) {
                  recordCompileSpend(error.usage.costUsd);
                }
                throw error;
              }
            },
          });
          await send({ type: "done", compiled: cold.value });
        } catch (error) {
          await send({ type: "error", reason: publicError(error) });
        } finally {
          clearInterval(heartbeat);
          clearTimeout(deadline);
          request.signal.removeEventListener("abort", abortForRequest);
          if (!streamClosed) {
            streamClosed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      streamClosed = true;
      if (!workAbort.signal.aborted) {
        workAbort.abort(new PipelineError("The live compile request was cancelled.", 499));
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
