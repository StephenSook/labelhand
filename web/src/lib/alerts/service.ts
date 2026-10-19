import type { AlertsConfig } from "./config";
import { answerWhyWithAgent } from "./agent";
import { alertFieldNames, loadAlertTank, planAlert } from "./planner";
import {
  callWindowId,
  clientLookupHash,
  newAlertId,
  phoneLookupHash,
  subscriptionIdentityId,
} from "./security";
import { AlertBlobStore } from "./storage";
import { easternDay, isEasternQuietHour, spokenWindow } from "./time";
import {
  initialCallTwiml,
  redirectTwiml,
  sayTwiml,
  TwilioAlertGateway,
  TwilioCallRequestError,
  TwilioVerificationRequestError,
  type AlertTwilio,
} from "./twilio";
import type {
  AlertCallLog,
  AlertConfirmResponse,
  AlertPlannerEvidence,
  AlertsRunResult,
  AlertStartResponse,
  AlertSubscription,
  PendingAlertVerification,
} from "./types";
import { parseAlertConfirm, parseAlertStart } from "./validation";

const VERIFY_TTL_MS = 10 * 60 * 1_000;

export class AlertsServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type AlertStore = Pick<AlertBlobStore,
  | "writePending"
  | "getOrCreateIdentitySecret"
  | "readPending"
  | "deletePending"
  | "sweepExpiredPending"
  | "reserveVerificationAttempt"
  | "releaseVerificationAttempt"
  | "createSubscription"
  | "updateSubscription"
  | "readSubscription"
  | "listActiveSubscriptions"
  | "claimCall"
  | "writeCall"
  | "readCall"
  | "deleteCall"
  | "reserveCapacity"
  | "releaseCapacity"
>;

export type AlertServiceDependencies = {
  store: AlertStore;
  twilio: AlertTwilio;
  now: () => Date;
  fields: typeof alertFieldNames;
  validateTank: typeof loadAlertTank;
  plan: typeof planAlert;
  answerWhy: typeof answerWhyWithAgent;
};

export function alertDependencies(config: AlertsConfig): AlertServiceDependencies {
  return {
    store: new AlertBlobStore(config),
    twilio: new TwilioAlertGateway(config),
    now: () => new Date(),
    fields: alertFieldNames,
    validateTank: loadAlertTank,
    plan: planAlert,
    answerWhy: answerWhyWithAgent,
  };
}

export async function startVerification(
  body: unknown,
  config: AlertsConfig,
  dependencies = alertDependencies(config),
  context: { clientAddress?: string } = {},
): Promise<AlertStartResponse> {
  const fields = await dependencies.fields();
  const input = parseAlertStart(body, new Set(fields.keys()));
  const now = dependencies.now();
  const id = newAlertId();
  const identitySecret = await dependencies.store.getOrCreateIdentitySecret();
  const phoneHash = phoneLookupHash(input.phoneNumber, identitySecret);
  const clientHash = clientLookupHash(context.clientAddress ?? "unknown", identitySecret);
  try {
    await dependencies.validateTank(input.tankRegs);
  } catch (error) {
    if (error instanceof RangeError) throw new AlertsServiceError(error.message, 400);
    throw error;
  }
  const verificationCapacity = await dependencies.store.reserveVerificationAttempt(
    clientHash,
    phoneHash,
    easternDay(now),
    id,
  );
  if (verificationCapacity.status !== "reserved") {
    throw new AlertsServiceError("Too many phone verification attempts. Try again tomorrow.", 429);
  }
  const pending: PendingAlertVerification = {
    schemaVersion: 1,
    id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + VERIFY_TTL_MS).toISOString(),
    field: input.field,
    tankRegs: input.tankRegs,
    jobHours: input.jobHours,
    phoneNumber: input.phoneNumber,
    phoneHash,
    channel: input.channel,
  };
  try {
    await dependencies.store.writePending(pending);
  } catch (error) {
    try {
      await dependencies.store.releaseVerificationAttempt(verificationCapacity.reservation);
    } catch {
      // Retained slots fail closed against Verify abuse.
    }
    throw error;
  }
  try {
    await dependencies.twilio.startVerification(input.phoneNumber, input.channel, phoneHash);
  } catch (error) {
    try {
      await dependencies.store.deletePending(id);
    } catch {
      // A stale pending record cannot be called and expires before it can be confirmed.
    }
    if (error instanceof TwilioVerificationRequestError && error.definitelyNotSent) {
      try {
        await dependencies.store.releaseVerificationAttempt(verificationCapacity.reservation);
      } catch {
        // Retained slots fail closed against Verify abuse.
      }
    }
    throw new AlertsServiceError("Twilio could not start the phone verification.", 502);
  }
  return { verificationId: id, status: "pending", channel: input.channel };
}

export async function confirmVerification(
  body: unknown,
  config: AlertsConfig,
  dependencies = alertDependencies(config),
): Promise<AlertConfirmResponse> {
  const input = parseAlertConfirm(body);
  const pending = await dependencies.store.readPending(input.verificationId);
  if (!pending) throw new AlertsServiceError("The verification request was not found.", 404);
  if (Date.parse(pending.expiresAt) <= dependencies.now().getTime()) {
    try {
      await dependencies.store.deletePending(pending.id);
    } catch {
      // The expired record remains harmless because this branch never calls Verify again.
    }
    throw new AlertsServiceError("The verification request expired. Start a new one.", 410);
  }

  let status: string;
  try {
    status = await dependencies.twilio.checkVerification(pending.phoneNumber, input.code);
  } catch {
    throw new AlertsServiceError("Twilio could not check the verification code.", 502);
  }
  if (status !== "approved") throw new AlertsServiceError("The verification code was not approved.", 400);

  const verifiedAt = dependencies.now().toISOString();
  const identitySecret = await dependencies.store.getOrCreateIdentitySecret();
  const subscriptionId = subscriptionIdentityId(
    pending.phoneHash,
    pending.field,
    pending.tankRegs,
    pending.jobHours,
    identitySecret,
  );
  const existing = await dependencies.store.readSubscription(subscriptionId);
  const subscription: AlertSubscription = {
    schemaVersion: 1,
    id: subscriptionId,
    createdAt: existing?.createdAt ?? pending.createdAt,
    verifiedAt,
    active: true,
    field: pending.field,
    tankRegs: pending.tankRegs,
    jobHours: pending.jobHours,
    phoneNumber: pending.phoneNumber,
    phoneHash: pending.phoneHash,
    channel: pending.channel,
  };
  if (existing) {
    if (existing.phoneHash !== subscription.phoneHash) {
      throw new AlertsServiceError("The verified subscription identity collided.", 503);
    }
    await dependencies.store.updateSubscription(subscription);
  } else if (!await dependencies.store.createSubscription(subscription)) {
    const raced = await dependencies.store.readSubscription(subscription.id);
    if (raced?.phoneHash !== subscription.phoneHash) {
      throw new AlertsServiceError("The verified subscription could not be created.", 503);
    }
  }
  try {
    await dependencies.store.deletePending(pending.id);
  } catch {
    // The active subscription is the source of truth after an approved check.
  }
  return { subscriptionId: subscription.id, status: "active" };
}

function whyUrl(config: AlertsConfig, subscriptionId: string, callId: string): string {
  const url = new URL("/api/alerts/voice/why", `${config.publicBaseUrl}/`);
  url.searchParams.set("subscription", subscriptionId);
  url.searchParams.set("call", callId);
  return url.toString();
}

function stopUrl(config: AlertsConfig, subscriptionId: string, callId: string): string {
  const url = new URL("/api/alerts/voice/stop", `${config.publicBaseUrl}/`);
  url.searchParams.set("subscription", subscriptionId);
  url.searchParams.set("call", callId);
  return url.toString();
}

function callPrompt(planner: AlertPlannerEvidence, now: Date): string {
  const products = planner.products.map((product) => product.name).join(", ");
  return `This is Labelhand. At ${planner.fieldName}, the tank of ${products} is forecast-permitted ${spokenWindow(planner.calledWindow.start, planner.calledWindow.end, now)}. Press 1 or say why to hear what limits the rest of the day. Press 9 to stop these calls.`;
}

export async function runAlerts(
  config: AlertsConfig,
  dependencies = alertDependencies(config),
): Promise<AlertsRunResult> {
  const startedAt = dependencies.now();
  const result: AlertsRunResult = {
    scanned: 0,
    called: 0,
    noWindow: 0,
    duplicate: 0,
    capped: 0,
    failed: 0,
    cleanupFailed: false,
    quietHours: isEasternQuietHour(startedAt),
  };
  if (result.quietHours) return result;

  try {
    await dependencies.store.sweepExpiredPending(startedAt);
  } catch {
    result.cleanupFailed = true;
  }
  const subscriptions = await dependencies.store.listActiveSubscriptions();
  result.scanned = subscriptions.length;
  for (const subscription of subscriptions) {
    const planningNow = dependencies.now();
    if (isEasternQuietHour(planningNow)) {
      result.quietHours = true;
      break;
    }
    try {
      const planner = await dependencies.plan(subscription, { now: planningNow });
      if (!planner) {
        result.noWindow += 1;
        continue;
      }
      const id = callWindowId(subscription.id, planner.calledWindow.start);
      const day = easternDay(planningNow);
      const log: AlertCallLog = {
        schemaVersion: 1,
        id,
        subscriptionId: subscription.id,
        phoneHash: subscription.phoneHash,
        createdAt: planningNow.toISOString(),
        easternDay: day,
        status: "reserved",
        planner,
      };
      if (!await dependencies.store.claimCall(log)) {
        result.duplicate += 1;
        continue;
      }
      let capacity: Awaited<ReturnType<AlertStore["reserveCapacity"]>>;
      try {
        capacity = await dependencies.store.reserveCapacity(subscription.id, subscription.phoneHash, day, id);
      } catch {
        try {
          await dependencies.store.deleteCall(subscription.id, id);
        } catch {
          // A retained claim fails closed against a duplicate call.
        }
        result.failed += 1;
        continue;
      }
      if (capacity.status !== "reserved") {
        try {
          await dependencies.store.deleteCall(subscription.id, id);
        } catch {
          // Keeping a claim after a storage failure is safer than risking a duplicate call.
        }
        result.capped += 1;
        continue;
      }

      const releaseUnplaced = async () => {
        try {
          await dependencies.store.releaseCapacity(capacity.reservation);
        } catch {
          // A retained slot lowers the cap rather than allowing an extra call.
        }
        try {
          await dependencies.store.deleteCall(subscription.id, id);
        } catch {
          // A retained claim fails closed against a duplicate call.
        }
      };

      let currentSubscription: AlertSubscription | null;
      try {
        currentSubscription = await dependencies.store.readSubscription(subscription.id);
      } catch {
        await releaseUnplaced();
        result.failed += 1;
        continue;
      }
      if (!currentSubscription?.active || !currentSubscription.phoneNumber) {
        await releaseUnplaced();
        continue;
      }
      const callNow = dependencies.now();
      if (isEasternQuietHour(callNow)) {
        await releaseUnplaced();
        result.quietHours = true;
        break;
      }

      const twiml = initialCallTwiml(callPrompt(planner, callNow), whyUrl(config, subscription.id, id));
      let placed: { sid: string };
      try {
        placed = await dependencies.twilio.placeCall(currentSubscription.phoneNumber, twiml);
      } catch (error) {
        if (error instanceof TwilioCallRequestError && error.definitelyNotPlaced) {
          await releaseUnplaced();
        } else {
          try {
            await dependencies.store.writeCall({ ...log, status: "failed", failure: "Twilio call request failed." });
          } catch {
            // The reserved log still prevents a possibly placed call from being repeated.
          }
        }
        result.failed += 1;
        continue;
      }
      result.called += 1;
      try {
        await dependencies.store.writeCall({ ...log, status: "queued", twilioCallSid: placed.sid });
      } catch {
        // The reserved log already contains every fact the signed voice webhook needs.
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export type VoiceAction = { kind: "say" | "redirect"; twiml: string };

export async function answerVoiceWhy(
  subscriptionId: string,
  callId: string,
  params: Record<string, string>,
  config: AlertsConfig,
  dependencies = alertDependencies(config),
): Promise<VoiceAction> {
  const digit = params.Digits?.trim();
  const speech = params.SpeechResult?.trim().toLowerCase() ?? "";
  if (digit === "9" || /\bstop\b/.test(speech)) {
    return { kind: "redirect", twiml: redirectTwiml(stopUrl(config, subscriptionId, callId)) };
  }
  if (digit !== "1" && !/\bwhy\b/.test(speech)) {
    return { kind: "say", twiml: sayTwiml("That response was not recognized. No subscription change was made.") };
  }
  const log = await dependencies.store.readCall(subscriptionId, callId);
  if (!log) throw new AlertsServiceError("The planner result for this call was not found.", 404);
  const answer = await dependencies.answerWhy(log.planner);
  return { kind: "say", twiml: sayTwiml(answer || log.planner.fallbackSummary) };
}

export async function stopVoiceCalls(
  subscriptionId: string,
  callId: string,
  config: AlertsConfig,
  dependencies = alertDependencies(config),
): Promise<string> {
  const log = await dependencies.store.readCall(subscriptionId, callId);
  if (!log) throw new AlertsServiceError("The call record was not found.", 404);
  const subscription = await dependencies.store.readSubscription(subscriptionId);
  if (!subscription) throw new AlertsServiceError("The alert subscription was not found.", 404);
  if (subscription.active) {
    const redacted: AlertSubscription = {
      ...subscription,
      active: false,
      unsubscribedAt: dependencies.now().toISOString(),
    };
    delete redacted.phoneNumber;
    await dependencies.store.updateSubscription(redacted);
  }
  return sayTwiml("Labelhand calls are stopped. Goodbye.");
}
