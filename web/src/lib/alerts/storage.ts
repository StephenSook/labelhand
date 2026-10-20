import { randomBytes } from "node:crypto";

import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";

import type { AlertsConfig } from "./config";
import type { AlertCallLog, AlertSubscription, PendingAlertVerification } from "./types";

const JSON_CONTENT_TYPE = "application/json";
export const PENDING_PREFIX = "alerts/pending/";
export const SUBSCRIPTION_PREFIX = "alerts/subscriptions/";
export const CALL_LOG_PREFIX = "alerts/log/";
export const CAP_PREFIX = "alerts/caps/";
export const VERIFY_CAP_PREFIX = "alerts/verify-caps/";
export const IDENTITY_SECRET_PATH = "alerts/system/identity-secret.json";
export const CALLS_PER_SUBSCRIPTION_PER_DAY = 3;
export const CALLS_PER_PHONE_PER_DAY = 9;
export const CALLS_TOTAL_PER_DAY = 30;
export const VERIFY_STARTS_PER_PHONE_PER_DAY = 5;
export const VERIFY_STARTS_PER_CLIENT_PER_DAY = 20;
export const VERIFY_STARTS_TOTAL_PER_DAY = 100;

type BlobApi = {
  get: typeof get;
  list: typeof list;
  put: typeof put;
  del: typeof del;
};

export type CapacityReservation = {
  subscriptionSlot: string;
  phoneSlot: string;
  totalSlot: string;
};

export type CapacityResult =
  | { status: "reserved"; reservation: CapacityReservation }
  | { status: "subscription-cap" | "phone-cap" | "total-cap" };

export type VerificationReservation = { phoneSlot: string; clientSlot: string; totalSlot: string };
export type VerificationCapacityResult =
  | { status: "reserved"; reservation: VerificationReservation }
  | { status: "phone-cap" | "client-cap" | "total-cap" };

function pendingPath(id: string): string {
  return `${PENDING_PREFIX}${id}.json`;
}

function subscriptionPath(id: string): string {
  return `${SUBSCRIPTION_PREFIX}${id}.json`;
}

function callPath(subscriptionId: string, callId: string): string {
  return `${CALL_LOG_PREFIX}${subscriptionId}/${callId}.json`;
}

function isPreconditionFailure(error: unknown): boolean {
  return error instanceof BlobPreconditionFailedError
    || (error instanceof Error && error.name === "BlobPreconditionFailedError");
}

async function responseJson(result: Awaited<ReturnType<typeof get>>): Promise<unknown | null> {
  if (!result) return null;
  return await new Response(result.stream).json() as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPending(value: unknown): value is PendingAlertVerification {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && typeof value.expiresAt === "string"
    && typeof value.field === "string"
    && Array.isArray(value.tankRegs)
    && typeof value.jobHours === "number"
    && typeof value.phoneNumber === "string"
    && typeof value.phoneHash === "string"
    && (value.channel === "sms" || value.channel === "call");
}

function isSubscription(value: unknown): value is AlertSubscription {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && typeof value.verifiedAt === "string"
    && typeof value.active === "boolean"
    && typeof value.field === "string"
    && Array.isArray(value.tankRegs)
    && typeof value.jobHours === "number"
    && (typeof value.phoneNumber === "string" || (value.active === false && value.phoneNumber === undefined))
    && typeof value.phoneHash === "string"
    && (value.channel === "sms" || value.channel === "call");
}

function isCallLog(value: unknown): value is AlertCallLog {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.id === "string"
    && typeof value.subscriptionId === "string"
    && typeof value.phoneHash === "string"
    && typeof value.createdAt === "string"
    && typeof value.easternDay === "string"
    && ["reserved", "queued", "failed"].includes(String(value.status))
    && isRecord(value.planner);
}

function identitySecret(value: unknown): string | null {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.secret === "string"
    && /^[a-f0-9]{64}$/.test(value.secret)
    ? value.secret
    : null;
}

export class AlertBlobStore {
  constructor(
    private readonly config: Pick<AlertsConfig, "blobToken">,
    private readonly api: BlobApi = { get, list, put, del },
  ) {}

  private async read(pathname: string): Promise<unknown | null> {
    return responseJson(await this.api.get(pathname, {
      access: "private",
      token: this.config.blobToken,
      useCache: false,
    }));
  }

  private async exists(pathname: string): Promise<boolean> {
    return (await this.api.get(pathname, {
      access: "private",
      token: this.config.blobToken,
      useCache: false,
    })) !== null;
  }

  private async write(pathname: string, value: unknown, allowOverwrite: boolean): Promise<boolean> {
    try {
      await this.api.put(pathname, JSON.stringify(value), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite,
        contentType: JSON_CONTENT_TYPE,
        token: this.config.blobToken,
      });
      return true;
    } catch (error) {
      if (allowOverwrite) throw error;
      if (isPreconditionFailure(error)) return false;
      // Vercel Blob answers a create-only put on a taken pathname with a plain BlobError
      // ("This blob already exists"), not BlobPreconditionFailedError. Ask the store
      // whether the pathname is taken before treating the failure as unexpected.
      if (await this.exists(pathname)) return false;
      throw error;
    }
  }

  async writePending(record: PendingAlertVerification): Promise<void> {
    if (!await this.write(pendingPath(record.id), record, false)) throw new Error("The pending verification already exists.");
  }

  async getOrCreateIdentitySecret(): Promise<string> {
    const existing = await this.read(IDENTITY_SECRET_PATH);
    if (existing !== null) {
      const secret = identitySecret(existing);
      if (!secret) throw new TypeError("The alert identity secret is corrupt.");
      return secret;
    }
    const generated = randomBytes(32).toString("hex");
    if (await this.write(IDENTITY_SECRET_PATH, { schemaVersion: 1, secret: generated }, false)) return generated;
    const raced = identitySecret(await this.read(IDENTITY_SECRET_PATH));
    if (!raced) throw new TypeError("The alert identity secret could not be created.");
    return raced;
  }

  async readPending(id: string): Promise<PendingAlertVerification | null> {
    const value = await this.read(pendingPath(id));
    if (value === null) return null;
    if (!isPending(value) || value.id !== id) throw new TypeError("The pending alert verification is corrupt.");
    return value;
  }

  async deletePending(id: string): Promise<void> {
    await this.api.del(pendingPath(id), { token: this.config.blobToken });
  }

  async sweepExpiredPending(now: Date): Promise<void> {
    const pathnames: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.list({
        prefix: PENDING_PREFIX,
        limit: 100,
        token: this.config.blobToken,
        ...(cursor ? { cursor } : {}),
      });
      pathnames.push(...page.blobs.map((blob) => blob.pathname));
      if (pathnames.length > 10_000) throw new Error("The pending verification list exceeded its safety limit.");
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const expired: string[] = [];
    for (let offset = 0; offset < pathnames.length; offset += 10) {
      const batch = pathnames.slice(offset, offset + 10);
      const results = await Promise.all(batch.map(async (pathname) => {
        const value = await this.read(pathname);
        if (!isPending(value)) throw new TypeError(`Pending alert verification ${pathname} is corrupt.`);
        return Date.parse(value.expiresAt) <= now.getTime() ? pathname : null;
      }));
      expired.push(...results.filter((pathname): pathname is string => pathname !== null));
    }
    for (let offset = 0; offset < expired.length; offset += 100) {
      await this.api.del(expired.slice(offset, offset + 100), { token: this.config.blobToken });
    }
  }

  async createSubscription(record: AlertSubscription): Promise<boolean> {
    return this.write(subscriptionPath(record.id), record, false);
  }

  async updateSubscription(record: AlertSubscription): Promise<void> {
    await this.write(subscriptionPath(record.id), record, true);
  }

  async readSubscription(id: string): Promise<AlertSubscription | null> {
    const value = await this.read(subscriptionPath(id));
    if (value === null) return null;
    if (!isSubscription(value) || value.id !== id) throw new TypeError("The alert subscription is corrupt.");
    return value;
  }

  async listActiveSubscriptions(): Promise<AlertSubscription[]> {
    const pathnames: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.list({
        prefix: SUBSCRIPTION_PREFIX,
        limit: 1_000,
        token: this.config.blobToken,
        ...(cursor ? { cursor } : {}),
      });
      pathnames.push(...page.blobs.map((blob) => blob.pathname));
      if (pathnames.length > 10_000) throw new Error("The alert subscription list exceeded its safety limit.");
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    const subscriptions = await Promise.all(pathnames.map(async (pathname) => {
      const value = await this.read(pathname);
      if (!isSubscription(value)) throw new TypeError(`Alert subscription ${pathname} is corrupt.`);
      return value;
    }));
    return subscriptions.filter((subscription) => subscription.active);
  }

  async claimCall(log: AlertCallLog): Promise<boolean> {
    return this.write(callPath(log.subscriptionId, log.id), log, false);
  }

  async writeCall(log: AlertCallLog): Promise<void> {
    await this.write(callPath(log.subscriptionId, log.id), log, true);
  }

  async readCall(subscriptionId: string, callId: string): Promise<AlertCallLog | null> {
    const value = await this.read(callPath(subscriptionId, callId));
    if (value === null) return null;
    if (!isCallLog(value) || value.id !== callId || value.subscriptionId !== subscriptionId) {
      throw new TypeError("The alert call log is corrupt.");
    }
    return value;
  }

  async deleteCall(subscriptionId: string, callId: string): Promise<void> {
    await this.api.del(callPath(subscriptionId, callId), { token: this.config.blobToken });
  }

  private async reserveSlot(prefix: string, maximum: number, callId: string): Promise<string | null> {
    for (let slot = 1; slot <= maximum; slot += 1) {
      const pathname = `${prefix}${String(slot).padStart(2, "0")}.json`;
      if (await this.write(pathname, { callId }, false)) return pathname;
    }
    return null;
  }

  async reserveVerificationAttempt(
    clientHash: string,
    phoneHash: string,
    day: string,
    attemptId: string,
  ): Promise<VerificationCapacityResult> {
    const phoneSlot = await this.reserveSlot(
      `${VERIFY_CAP_PREFIX}${day}/phones/${phoneHash}/`,
      VERIFY_STARTS_PER_PHONE_PER_DAY,
      attemptId,
    );
    if (!phoneSlot) return { status: "phone-cap" };
    let clientSlot: string | null;
    try {
      clientSlot = await this.reserveSlot(
        `${VERIFY_CAP_PREFIX}${day}/clients/${clientHash}/`,
        VERIFY_STARTS_PER_CLIENT_PER_DAY,
        attemptId,
      );
    } catch (error) {
      try {
        await this.api.del(phoneSlot, { token: this.config.blobToken });
      } catch {
        // A leaked verification slot lowers the limit rather than enabling abuse.
      }
      throw error;
    }
    if (!clientSlot) {
      await this.api.del(phoneSlot, { token: this.config.blobToken });
      return { status: "client-cap" };
    }
    let totalSlot: string | null;
    try {
      totalSlot = await this.reserveSlot(
        `${VERIFY_CAP_PREFIX}${day}/total/`,
        VERIFY_STARTS_TOTAL_PER_DAY,
        attemptId,
      );
    } catch (error) {
      try {
        await this.api.del([phoneSlot, clientSlot], { token: this.config.blobToken });
      } catch {
        // Leaked verification slots lower the limits rather than enabling abuse.
      }
      throw error;
    }
    if (!totalSlot) {
      await this.api.del([phoneSlot, clientSlot], { token: this.config.blobToken });
      return { status: "total-cap" };
    }
    return { status: "reserved", reservation: { phoneSlot, clientSlot, totalSlot } };
  }

  async releaseVerificationAttempt(reservation: VerificationReservation): Promise<void> {
    await this.api.del(
      [reservation.phoneSlot, reservation.clientSlot, reservation.totalSlot],
      { token: this.config.blobToken },
    );
  }

  async reserveCapacity(subscriptionId: string, phoneHash: string, day: string, callId: string): Promise<CapacityResult> {
    const subscriptionSlot = await this.reserveSlot(
      `${CAP_PREFIX}${day}/subscriptions/${subscriptionId}/`,
      CALLS_PER_SUBSCRIPTION_PER_DAY,
      callId,
    );
    if (!subscriptionSlot) return { status: "subscription-cap" };

    let phoneSlot: string | null;
    try {
      phoneSlot = await this.reserveSlot(
        `${CAP_PREFIX}${day}/phones/${phoneHash}/`,
        CALLS_PER_PHONE_PER_DAY,
        callId,
      );
    } catch (error) {
      try {
        await this.api.del(subscriptionSlot, { token: this.config.blobToken });
      } catch {
        // A leaked slot lowers the cap rather than allowing an extra call.
      }
      throw error;
    }
    if (!phoneSlot) {
      await this.api.del(subscriptionSlot, { token: this.config.blobToken });
      return { status: "phone-cap" };
    }

    let totalSlot: string | null;
    try {
      totalSlot = await this.reserveSlot(`${CAP_PREFIX}${day}/total/`, CALLS_TOTAL_PER_DAY, callId);
    } catch (error) {
      try {
        await this.api.del([subscriptionSlot, phoneSlot], { token: this.config.blobToken });
      } catch {
        // A leaked slot lowers the cap rather than allowing an extra call.
      }
      throw error;
    }
    if (!totalSlot) {
      await this.api.del([subscriptionSlot, phoneSlot], { token: this.config.blobToken });
      return { status: "total-cap" };
    }
    return { status: "reserved", reservation: { subscriptionSlot, phoneSlot, totalSlot } };
  }

  async releaseCapacity(reservation: CapacityReservation): Promise<void> {
    await this.api.del(
      [reservation.subscriptionSlot, reservation.phoneSlot, reservation.totalSlot],
      { token: this.config.blobToken },
    );
  }
}
