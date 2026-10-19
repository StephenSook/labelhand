import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import forecastPoints from "../../../../../public/data/nws_points_cache.json";

export const runtime = "nodejs";

const REGION = "eu-north1";
const CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=60";
const KNOWN_POINTS = new Set(forecastPoints.map((point) => point.name));
const REQUIRED_ENV = [
  "SEASON_BUCKET",
  "SEASON_S3_ENDPOINT",
  "SEASON_READ_KEY_ID",
  "SEASON_READ_SECRET",
] as const;

function plain(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function seasonObjectKey(path: string[]): string | undefined {
  if (path.length === 1 && path[0] === "index.json") return "season/index.json";
  if (path.length !== 2 || !KNOWN_POINTS.has(path[0])) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(path[1]);
  if (!match || !validDay(match[1])) return undefined;
  return `season/${path[0]}/${match[1]}.json`;
}

function missingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}

function storageErrorDetails(error: unknown, key: string) {
  const value = typeof error === "object" && error !== null
    ? error as { name?: unknown; $metadata?: { httpStatusCode?: unknown; requestId?: unknown } }
    : undefined;
  return {
    key,
    errorName: typeof value?.name === "string" ? value.name : "UnknownError",
    httpStatusCode: typeof value?.$metadata?.httpStatusCode === "number"
      ? value.$metadata.httpStatusCode
      : undefined,
    requestId: typeof value?.$metadata?.requestId === "string"
      ? value.$metadata.requestId
      : undefined,
  };
}

function createClient() {
  return new S3Client({
    endpoint: process.env.SEASON_S3_ENDPOINT,
    region: REGION,
    credentials: {
      accessKeyId: process.env.SEASON_READ_KEY_ID!,
      secretAccessKey: process.env.SEASON_READ_SECRET!,
    },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) return plain("Season Object Storage is not configured on this deployment.", 503);

  const { path } = await context.params;
  const key = seasonObjectKey(path);
  if (!key) return plain("The requested season path is invalid.", 400);

  try {
    const result = await createClient().send(new GetObjectCommand({
      Bucket: process.env.SEASON_BUCKET,
      Key: key,
    }));
    if (!result.Body) throw new TypeError("Object Storage returned an empty body");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("Object Storage returned JSON that is not an object");
    }
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "cache-control": CACHE_CONTROL,
        "content-length": String(bytes.byteLength),
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    if (missingObject(error)) return plain("This season recording was not found.", 404);
    console.error("Season Object Storage read failed.", storageErrorDetails(error, key));
    return plain("The season recording could not be read from Object Storage.", 502);
  }
}
