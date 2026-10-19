import { NextResponse } from "next/server";

import { AlertsConfigError } from "./config";
import { AlertsServiceError } from "./service";
import { sayTwiml } from "./twilio";
import { AlertInputError } from "./validation";

export function jsonError(error: unknown): NextResponse {
  if (error instanceof AlertsConfigError || error instanceof AlertsServiceError || error instanceof AlertInputError) {
    return NextResponse.json({ error: error.message, status: error.status }, { status: error.status });
  }
  return NextResponse.json({ error: "Alerts are temporarily unavailable.", status: 503 }, { status: 503 });
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
  return twimlResponse(sayTwiml("Alerts are temporarily unavailable."), 503);
}

export async function requestJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text()) as unknown;
  } catch {
    throw new AlertInputError("The request body is not valid JSON.");
  }
}
