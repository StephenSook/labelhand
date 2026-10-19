import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

import type { CompiledLiveLabel } from "./compiler/pipeline";
import { LIVE_COMPILE_READINGS } from "./live-limits";

const JSON_CONTENT_TYPE = "application/json";

export interface LiveCacheIndex {
  reg: string;
  product: string;
  fileName: string;
  accepted: string;
  labelUrl: string;
  sha256: string;
  pipelineVersion: string;
}

function token(): string | null {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() || null;
}

export function liveCacheConfigured(): boolean {
  return token() !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isLiveCacheIndex(value: unknown): value is LiveCacheIndex {
  return isRecord(value)
    && typeof value.reg === "string"
    && typeof value.product === "string"
    && typeof value.fileName === "string"
    && typeof value.accepted === "string"
    && typeof value.labelUrl === "string"
    && isSha256(value.sha256)
    && typeof value.pipelineVersion === "string";
}

function isCompiledLiveLabel(value: unknown): value is CompiledLiveLabel {
  return isRecord(value)
    && typeof value.reg === "string"
    && typeof value.product === "string"
    && isSha256(value.label_sha256)
    && typeof value.pipeline_version === "string"
    && value.scored === false
    && typeof value.restricted_use === "boolean"
    && value.complete === true
    && value.readings === LIVE_COMPILE_READINGS
    && Array.isArray(value.reading_records)
    && value.reading_records.length === LIVE_COMPILE_READINGS
    && Array.isArray(value.merged_from)
    && value.merged_from.length === LIVE_COMPILE_READINGS
    && Array.isArray(value.accepted)
    && Array.isArray(value.rejected);
}

export function compiledCacheKey(sha256: string, pipelineVersion: string): string {
  if (!isSha256(sha256)) throw new TypeError("A lowercase SHA-256 is required for the live cache key.");
  if (!/^[A-Za-z0-9._-]+$/.test(pipelineVersion)) throw new TypeError("The pipeline version is not cache-key safe.");
  return `compiled/${sha256}.${pipelineVersion}.json`;
}

export function fileIndexCacheKey(fileName: string): string {
  if (!/^\d{6}-\d{5}-\d{8}\.pdf$/.test(fileName)) throw new TypeError("The PPLS file name is not cache-key safe.");
  return `index/${fileName}.json`;
}

export function registrationIndexCacheKey(reg: string): string {
  if (!/^\d{1,6}-\d{1,5}$/.test(reg)) throw new TypeError("A federal registration number is required for the cache key.");
  return `registration/${reg}.json`;
}

async function readJson(pathname: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    return await readJsonStrict(pathname, signal);
  } catch {
    return null;
  }
}

async function readJsonStrict(pathname: string, signal?: AbortSignal): Promise<unknown | null> {
  const blobToken = token();
  if (!blobToken) return null;
  const result = await get(pathname, {
    access: "private",
    token: blobToken,
    useCache: false,
    ...(signal ? { abortSignal: signal } : {}),
  });
  if (!result) return null;
  return await new Response(result.stream).json() as unknown;
}

export async function getLiveCacheIndex(fileName: string, signal?: AbortSignal): Promise<LiveCacheIndex | null> {
  const value = await readJson(fileIndexCacheKey(fileName), signal);
  return isLiveCacheIndex(value) ? value : null;
}

export async function getRegistrationCacheIndex(reg: string, signal?: AbortSignal): Promise<LiveCacheIndex | null> {
  const value = await readJson(registrationIndexCacheKey(reg), signal);
  return isLiveCacheIndex(value) && value.reg === reg ? value : null;
}

export async function getRegistrationCacheIndexStrict(
  reg: string,
  signal?: AbortSignal,
): Promise<LiveCacheIndex | null> {
  const value = await readJsonStrict(registrationIndexCacheKey(reg), signal);
  if (value === null) return null;
  if (!isLiveCacheIndex(value) || value.reg !== reg) throw new TypeError("The live registration cache index is corrupt.");
  return value;
}

export async function getCachedLiveLabel(
  sha256: string,
  pipelineVersion: string,
  signal?: AbortSignal,
): Promise<CompiledLiveLabel | null> {
  const value = await readJson(compiledCacheKey(sha256, pipelineVersion), signal);
  if (!isCompiledLiveLabel(value)) return null;
  if (value.label_sha256 !== sha256 || value.pipeline_version !== pipelineVersion) return null;
  return value;
}

export async function getCachedLiveLabelStrict(
  sha256: string,
  pipelineVersion: string,
  signal?: AbortSignal,
): Promise<CompiledLiveLabel | null> {
  const value = await readJsonStrict(compiledCacheKey(sha256, pipelineVersion), signal);
  if (value === null) return null;
  if (
    !isCompiledLiveLabel(value)
    || value.label_sha256 !== sha256
    || value.pipeline_version !== pipelineVersion
  ) {
    throw new TypeError("The compiled live-label cache entry is corrupt.");
  }
  return value;
}

export async function writeLiveCache(compiled: CompiledLiveLabel, signal?: AbortSignal): Promise<boolean> {
  const blobToken = token();
  if (!blobToken || !compiled.complete) return false;
  const compiledKey = compiledCacheKey(compiled.label_sha256, compiled.pipeline_version);
  try {
    await put(compiledKey, JSON.stringify(compiled), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 86_400,
      contentType: JSON_CONTENT_TYPE,
      token: blobToken,
      ...(signal ? { abortSignal: signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof BlobPreconditionFailedError)) return false;
  }

  const index: LiveCacheIndex = {
    reg: compiled.reg,
    product: compiled.product,
    fileName: compiled.label_file,
    accepted: compiled.label_accepted,
    labelUrl: compiled.label_url,
    sha256: compiled.label_sha256,
    pipelineVersion: compiled.pipeline_version,
  };
  try {
    await put(registrationIndexCacheKey(compiled.reg), JSON.stringify(index), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 86_400,
      contentType: JSON_CONTENT_TYPE,
      token: blobToken,
      ...(signal ? { abortSignal: signal } : {}),
    });
  } catch {
    return false;
  }
  try {
    await put(fileIndexCacheKey(compiled.label_file), JSON.stringify(index), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 86_400,
      contentType: JSON_CONTENT_TYPE,
      token: blobToken,
      ...(signal ? { abortSignal: signal } : {}),
    });
  } catch {
    // The registration pointer still makes the compiled cache reachable.
  }
  return true;
}
