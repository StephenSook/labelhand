import { NextRequest, NextResponse } from "next/server";

import { diffLabelVersions } from "@/lib/label-versions";
import { assertCacheHitAllowed, LiveLimitError } from "@/lib/live-limits";
import { PplsError } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 60;

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const reg = params.get("reg") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  try {
    // Each uncached comparison fetches two EPA PDFs, so it shares the per-address label request limit.
    assertCacheHitAllowed(clientIp(request));
  } catch (error) {
    if (!(error instanceof LiveLimitError)) throw error;
    return NextResponse.json({ error: error.message, status: error.status }, {
      status: error.status,
      headers: { "cache-control": "no-store", "retry-after": String(error.retryAfterSeconds ?? 60) },
    });
  }
  try {
    const result = await diffLabelVersions(reg, from, to);
    return NextResponse.json(result, {
      // An accepted label PDF never changes under its file name, so neither does the comparison of two of them.
      headers: { "cache-control": "public, s-maxage=604800, stale-while-revalidate=2592000" },
    });
  } catch (error) {
    const status = error instanceof PplsError ? error.status : 502;
    const message = error instanceof PplsError
      ? error.message
      : "The two EPA label PDFs could not be read, so their text cannot be compared right now.";
    return NextResponse.json({ error: message, status }, { status, headers: { "cache-control": "no-store" } });
  }
}
