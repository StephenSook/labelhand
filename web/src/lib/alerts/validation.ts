import type { AlertConfirmRequest, AlertStartRequest, AlertVerificationChannel } from "./types";

const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const FEDERAL_REGISTRATION = /^\d{1,6}-\d{1,5}$/;
const VERIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFICATION_CODE = /^\d{4,10}$/;
const CALL_ID = /^[a-f0-9]{64}$/;

export class AlertInputError extends Error {
  readonly status = 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((key) => names.has(key));
}

export function parseAlertStart(value: unknown, allowedFields: ReadonlySet<string>): AlertStartRequest & { channel: AlertVerificationChannel } {
  if (!isRecord(value) || !onlyKeys(value, ["field", "tankRegs", "jobHours", "phoneNumber", "channel"])) {
    throw new AlertInputError("The request body contains unsupported fields.");
  }
  if (typeof value.field !== "string" || !allowedFields.has(value.field)) {
    throw new AlertInputError("field must name one of the configured forecast points.");
  }
  if (
    !Array.isArray(value.tankRegs)
    || value.tankRegs.length < 1
    || value.tankRegs.length > 6
    || value.tankRegs.some((reg) => typeof reg !== "string" || !FEDERAL_REGISTRATION.test(reg))
  ) {
    throw new AlertInputError("tankRegs must contain one to six federal registration numbers.");
  }
  const tankRegs = [...new Set(value.tankRegs as string[])];
  if (tankRegs.length !== value.tankRegs.length) throw new AlertInputError("tankRegs must not contain duplicates.");
  if (!Number.isInteger(value.jobHours) || (value.jobHours as number) < 1 || (value.jobHours as number) > 12) {
    throw new AlertInputError("jobHours must be an integer from 1 through 12.");
  }
  if (typeof value.phoneNumber !== "string" || !US_E164.test(value.phoneNumber)) {
    throw new AlertInputError("phoneNumber must be a US E.164 number such as +15555550100.");
  }
  const channel = value.channel ?? "sms";
  if (channel !== "sms" && channel !== "call") {
    throw new AlertInputError("channel must be sms or call.");
  }
  return {
    field: value.field,
    tankRegs,
    jobHours: value.jobHours as number,
    phoneNumber: value.phoneNumber,
    channel,
  };
}

export function parseAlertConfirm(value: unknown): AlertConfirmRequest {
  if (!isRecord(value) || !onlyKeys(value, ["verificationId", "code"])) {
    throw new AlertInputError("The request body contains unsupported fields.");
  }
  if (typeof value.verificationId !== "string" || !VERIFICATION_ID.test(value.verificationId)) {
    throw new AlertInputError("verificationId is invalid.");
  }
  if (typeof value.code !== "string" || !VERIFICATION_CODE.test(value.code)) {
    throw new AlertInputError("code must contain 4 to 10 digits.");
  }
  return { verificationId: value.verificationId, code: value.code };
}

export function validAlertId(value: string | null): value is string {
  return typeof value === "string" && VERIFICATION_ID.test(value);
}

export function validCallId(value: string | null): value is string {
  return typeof value === "string" && CALL_ID.test(value);
}
