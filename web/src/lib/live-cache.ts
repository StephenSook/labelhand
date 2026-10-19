import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

import type { CompiledLiveLabel } from "./compiler/pipeline";

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
    && value.complete === true
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

async function readJson(pathname: string): Promise<unknown | null> {
  const blobToken = token();
  if (!blobToken) return null;
  try {
    const result = await get(pathname, {
      access: "private",
      token: blobToken,
      useCache: false,
    });
    if (!result) return null;
    return await new Response(result.stream).json() as unknown;
  } catch {
    return null;
  }
}

export async function getLiveCacheIndex(fileName: string): Promise<LiveCacheIndex | null> {
  const value = await readJson(fileIndexCacheKey(fileName));
  return isLiveCacheIndex(value) ? value : null;
}

export async function getCachedLiveLabel(
  sha256: string,
  pipelineVersion: string,
): Promise<CompiledLiveLabel | null> {
  const value = await readJson(compiledCacheKey(sha256, pipelineVersion));
  if (!isCompiledLiveLabel(value)) return null;
  if (value.label_sha256 !== sha256 || value.pipeline_version !== pipelineVersion) return null;
  return value;
}

export async function writeLiveCache(compiled: CompiledLiveLabel): Promise<boolean> {
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
    await put(fileIndexCacheKey(compiled.label_file), JSON.stringify(index), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 86_400,
      contentType: JSON_CONTENT_TYPE,
      token: blobToken,
    });
    return true;
  } catch {
    return false;
  }
}
