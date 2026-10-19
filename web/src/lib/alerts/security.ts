import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export function newAlertId(): string {
  return randomUUID();
}

export function phoneLookupHash(phoneNumber: string, secret: string): string {
  return createHmac("sha256", secret).update(phoneNumber).digest("hex");
}

export function clientLookupHash(clientAddress: string, secret: string): string {
  return createHmac("sha256", secret).update("client\0").update(clientAddress).digest("hex");
}

export function subscriptionIdentityId(
  phoneHash: string,
  field: string,
  tankRegs: string[],
  jobHours: number,
  secret: string,
): string {
  const digest = createHmac("sha256", secret)
    .update("subscription\0")
    .update(JSON.stringify([phoneHash, field, [...tankRegs].sort(), jobHours]))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A permitted run is named by the hour it ends, not the hour it starts. Each hourly forecast
// starts at the current hour, so a run already under way loses an hour off its front every run
// and its start moves; its end does not, so one opening is claimed (and called) once.
export function callWindowId(subscriptionId: string, windowEnd: string): string {
  return createHash("sha256").update(subscriptionId).update("\0").update(windowEnd).digest("hex");
}

export function validBearer(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
