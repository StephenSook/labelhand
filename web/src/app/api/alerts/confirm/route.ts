import { NextRequest, NextResponse } from "next/server";

import { readAlertsConfig } from "@/lib/alerts/config";
import { jsonError, requestJson } from "@/lib/alerts/http";
import { confirmVerification } from "@/lib/alerts/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = readAlertsConfig();
    return NextResponse.json(await confirmVerification(await requestJson(request), config));
  } catch (error) {
    return jsonError(error);
  }
}
