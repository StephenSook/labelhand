import { NextResponse } from "next/server";

import { AlertsConfigError } from "./config";
import { AlertsServiceError } from "./service";
import { sayTwiml } from "./twilio";
import { AlertInputError } from "./validation";

// An unexpected error is logged by name and message only, so the runtime log says what broke
// without the request body (which can hold a phone number).
function logUnexpected(error: unknown): void {
  console.error("alerts: unexpected error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof AlertsConfigError || error instanceof AlertsServiceError || error instanceof AlertInputError) {
    return NextResponse.json({ error: error.message, status: error.status }, { status: error.status });
  }
  logUnexpected(error);
  // 503 stays reserved for a site where alerts are not configured; anything else is a 500.
  return NextResponse.json({ error: "Alerts hit an unexpected error. Try again in a minute.", status: 500 }, { status: 500 });
}

export function twimlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function twimlError(error: unknown): Response {
  if (error instanceof AlertsConfigError || error instanceof AlertsServiceError || error instanceof AlertInputError) {
    return twimlResponse(sayTwiml(error.message), error.status);
  }
  logUnexpected(error);
  return twimlResponse(sayTwiml("Alerts are temporarily unavailable."), 503);
}

export async function requestJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text()) as unknown;
  } catch {
    throw new AlertInputError("The request body is not valid JSON.");
  }
}
