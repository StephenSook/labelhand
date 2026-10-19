import type { NextRequest } from "next/server";

import type { AlertsConfig } from "./config";
import type { AlertTwilio } from "./twilio";

export async function validateTwilioWebhook(
  request: NextRequest,
  config: AlertsConfig,
  gateway: AlertTwilio,
): Promise<Record<string, string> | null> {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return null;
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") return null;
    params[name] = value;
  }
  const url = `${config.publicBaseUrl}${request.nextUrl.pathname}${request.nextUrl.search}`;
  try {
    return gateway.validate(signature, url, params) ? params : null;
  } catch {
    return null;
  }
}
