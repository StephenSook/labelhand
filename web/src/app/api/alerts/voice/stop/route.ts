import { NextRequest } from "next/server";

import { readAlertsConfig } from "@/lib/alerts/config";
import { twimlError, twimlResponse } from "@/lib/alerts/http";
import { alertDependencies, stopVoiceCalls } from "@/lib/alerts/service";
import { sayTwiml } from "@/lib/alerts/twilio";
import { validAlertId, validCallId } from "@/lib/alerts/validation";
import { validateTwilioWebhook } from "@/lib/alerts/webhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = readAlertsConfig();
    const dependencies = alertDependencies(config);
    const params = await validateTwilioWebhook(request, config, dependencies.twilio);
    if (!params) return twimlResponse(sayTwiml("Request refused."), 403);
    const subscriptionId = request.nextUrl.searchParams.get("subscription");
    const callId = request.nextUrl.searchParams.get("call");
    if (!validAlertId(subscriptionId) || !validCallId(callId)) {
      return twimlResponse(sayTwiml("The call reference is invalid."), 400);
    }
    return twimlResponse(await stopVoiceCalls(subscriptionId, callId, config, dependencies));
  } catch (error) {
    return twimlError(error);
  }
}
