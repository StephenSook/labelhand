import { NextRequest, NextResponse } from "next/server";

import { readAlertsConfig } from "@/lib/alerts/config";
import { jsonError, requestJson } from "@/lib/alerts/http";
import { startVerification } from "@/lib/alerts/service";

export const runtime = "nodejs";

function clientAddress(request: NextRequest): string {
  return request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const config = readAlertsConfig();
    return NextResponse.json(await startVerification(
      await requestJson(request),
      config,
      undefined,
      { clientAddress: clientAddress(request) },
    ), { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
