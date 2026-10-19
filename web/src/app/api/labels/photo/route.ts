import { NextRequest, NextResponse } from "next/server";

import {
  assertLivePhotoEnabled,
  assertPhotoReadAllowed,
  LiveLimitError,
} from "@/lib/live-limits";
import { reserveSharedPhotoRead } from "@/lib/live-ledger";
import {
  detectPhotoMime,
  MAX_PHOTO_BYTES,
  PhotoReadError,
  readLabelPhoto,
  type PhotoMime,
} from "@/lib/photo-reading";
import { PplsError } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

class PhotoRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PhotoRequestError";
  }
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function errorResponse(error: string, status: number, retryAfterSeconds?: number) {
  const response = NextResponse.json({ error, status }, { status });
  response.headers.set("cache-control", "no-store");
  if (retryAfterSeconds !== undefined) response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
}

async function readBoundedBody(request: NextRequest, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new PhotoRequestError("The label photo exceeds 4 MB.", 413);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function checkedImage(bytes: Uint8Array): { bytes: Uint8Array; mime: PhotoMime } {
  if (bytes.byteLength === 0) throw new PhotoRequestError("The label photo is empty.", 400);
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new PhotoRequestError("The label photo exceeds 4 MB.", 413);
  const mime = detectPhotoMime(bytes);
  if (!mime) throw new PhotoRequestError("The label photo must be a JPEG or PNG with a valid image signature.", 415);
  return { bytes, mime };
}

async function requestImage(request: NextRequest): Promise<{ bytes: Uint8Array; mime: PhotoMime }> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data;")) {
    const body = await readBoundedBody(request, MAX_PHOTO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
    let form: FormData;
    try {
      form = await new Request(request.url, {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "" },
        body: new Blob([body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer]),
      }).formData();
    } catch {
      throw new PhotoRequestError("The multipart photo request is invalid.", 400);
    }
    const values = form.getAll("photo");
    if (values.length !== 1 || [...form.keys()].some((key) => key !== "photo") || !(values[0] instanceof Blob)) {
      throw new PhotoRequestError("Send exactly one image in the multipart field photo.", 400);
    }
    if (values[0].size > MAX_PHOTO_BYTES) throw new PhotoRequestError("The label photo exceeds 4 MB.", 413);
    return checkedImage(new Uint8Array(await values[0].arrayBuffer()));
  }
  if (contentType === "image/jpeg" || contentType === "image/png") {
    return checkedImage(await readBoundedBody(request, MAX_PHOTO_BYTES));
  }
  throw new PhotoRequestError("Use multipart/form-data or raw image/jpeg or image/png.", 415);
}

export async function POST(request: NextRequest) {
  try {
    assertLivePhotoEnabled();
    assertPhotoReadAllowed(clientIp(request));
    const image = await requestImage(request);
    const apiKey = process.env.NEBIUS_API_KEY?.trim();
    if (!apiKey) return errorResponse("Label photo reading is not configured on this deployment.", 503);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(190_000)]);
    await reserveSharedPhotoRead({ ip: clientIp(request), signal });
    const result = await readLabelPhoto(image.bytes, image.mime, { apiKey, signal });
    return NextResponse.json(result, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof PhotoRequestError) return errorResponse(error.message, error.status);
    if (error instanceof LiveLimitError) return errorResponse(error.message, error.status, error.retryAfterSeconds);
    if (error instanceof PhotoReadError) {
      console.error(JSON.stringify({
        event: "label_photo_read_failed",
        status: error.status,
        diagnostic: error.diagnostic,
        usage: error.usage,
        request_ids: error.requestIds,
      }));
      return errorResponse(error.message, error.status);
    }
    if (error instanceof PplsError) return errorResponse(error.message, error.status);
    return errorResponse("Label photo reading failed.", 502);
  }
}
