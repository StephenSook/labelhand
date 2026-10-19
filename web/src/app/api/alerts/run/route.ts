import { NextRequest, NextResponse } from "next/server";

import { readAlertsConfig } from "@/lib/alerts/config";
import { jsonError } from "@/lib/alerts/http";
import { runAlerts } from "@/lib/alerts/service";
import { validBearer } from "@/lib/alerts/security";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const config = readAlertsConfig();
    if (!validBearer(request.headers.get("authorization"), config.runSecret)) {
      return NextResponse.json({ error: "Unauthorized.", status: 401 }, { status: 401 });
    }
    return NextResponse.json(await runAlerts(config));
  } catch (error) {
    return jsonError(error);
  }
}
