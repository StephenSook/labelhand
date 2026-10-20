import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { AlertsConfig } from "@/lib/alerts/config";
import { planAlert } from "@/lib/alerts/planner";
import { callWindowId, phoneLookupHash } from "@/lib/alerts/security";
import {
  answerVoiceWhy,
  confirmVerification,
  runAlerts,
  startVerification,
  stopVoiceCalls,
  type AlertServiceDependencies,
} from "@/lib/alerts/service";
import { AlertBlobStore, VERIFY_STARTS_TOTAL_PER_DAY } from "@/lib/alerts/storage";
import type { AlertCallLog, AlertPlannerEvidence, AlertSubscription } from "@/lib/alerts/types";
import {
  TwilioCallRequestError,
  TwilioVerificationRequestError,
  type AlertTwilio,
} from "@/lib/alerts/twilio";

const NOW = new Date("2026-10-06T10:00:00.000Z");
const SUBSCRIPTION_ID = "11111111-1111-4111-8111-111111111111";

const config: AlertsConfig = {
  twilioAccountSid: `AC${"1".repeat(32)}`,
  twilioAuthToken: "test-auth-token",
  twilioFromNumber: "+15555550100",
  twilioVerifyServiceSid: `VA${"2".repeat(32)}`,
  runSecret: "test-run-secret",
  publicBaseUrl: "https://labelhand.example.com",
  blobToken: "test-blob-token",
};

function fakeBlob() {
  const objects = new Map<string, string>();
  const api = {
    get: vi.fn(async (pathname: string) => {
      const value = objects.get(pathname);
      return value === undefined ? null : { stream: new Blob([value]).stream() };
    }) as never,
    list: vi.fn(async (options: { prefix?: string; cursor?: string; limit?: number }) => {
      const all = [...objects.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
      const start = Number(options.cursor ?? 0);
      const selected = all.slice(start, start + (options.limit ?? 1_000));
      const next = start + selected.length;
      return {
        blobs: selected.map((pathname) => ({ pathname })),
        hasMore: next < all.length,
        cursor: next < all.length ? String(next) : undefined,
      };
    }) as never,
    put: vi.fn(async (pathname: string, body: string, options: { allowOverwrite?: boolean }) => {
      if (objects.has(pathname) && options.allowOverwrite === false) {
        // What Vercel Blob actually throws for a create-only put on a taken pathname:
        // a plain BlobError, not BlobPreconditionFailedError (that one is for ifMatch).
        const error = new Error("Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.");
        error.name = "BlobError";
        throw error;
      }
      objects.set(pathname, body);
      return { pathname };
    }) as never,
    del: vi.fn(async (target: string | string[]) => {
      for (const pathname of Array.isArray(target) ? target : [target]) objects.delete(pathname);
    }) as never,
  };
  return { objects, api };
}

function fakeTwilio(): AlertTwilio & {
  startVerification: ReturnType<typeof vi.fn>;
  checkVerification: ReturnType<typeof vi.fn>;
  placeCall: ReturnType<typeof vi.fn>;
} {
  return {
    startVerification: vi.fn().mockResolvedValue(undefined),
    checkVerification: vi.fn().mockResolvedValue("approved"),
    placeCall: vi.fn().mockResolvedValue({ sid: `CA${"3".repeat(32)}` }),
    validate: vi.fn().mockReturnValue(true),
  };
}

function subscription(overrides: Partial<AlertSubscription> = {}): AlertSubscription {
  return {
    schemaVersion: 1,
    id: SUBSCRIPTION_ID,
    createdAt: "2026-10-06T09:00:00.000Z",
    verifiedAt: "2026-10-06T09:05:00.000Z",
    active: true,
    field: "tift",
    tankRegs: ["5481-504", "264-700", "264-418"],
    jobHours: 3,
    phoneNumber: "+15555550123",
    phoneHash: phoneLookupHash("+15555550123", config.runSecret),
    channel: "sms",
    ...overrides,
  };
}

function evidence(start = "2026-10-07T13:00:00-04:00"): AlertPlannerEvidence {
  const end = new Date(Date.parse(start) + 3 * 60 * 60 * 1_000).toISOString();
  return {
    fieldKey: "tift",
    fieldName: "Tift",
    products: [
      { reg: "5481-504", name: "Folex 6 EC" },
      { reg: "264-700", name: "Dropp SC" },
      { reg: "264-418", name: "Prep" },
    ],
    source: "LIVE",
    fetchedAt: NOW.toISOString(),
    jobHours: 3,
    calledWindow: { start, end, hours: 3 },
    agentCheck: {
      field: "Tift",
      products: ["5481-504", "264-700", "264-418"],
      job_hours: 3,
      source: { kind: "LIVE", time: NOW.toISOString() },
      counts: { FORECAST_PERMITTED: 3, FIELD_CHECK: 2, BLOCKED: 4 },
      windows: [{ index: 0, label: "Wed, Oct 7, 1 PM to Wed, Oct 7, 4 PM (3 h)", start, end, hours: 3 }],
      binding_clauses: [{
        rule_id: "5481-504-p3-1",
        product: "FOLEX 6 EC",
        page: 3,
        quote: "Do not apply during a temperature inversion.",
        why: "temperature inversion requires a field check",
        hour_label: "Wed, Oct 7, 6 PM",
      }],
    },
    fallbackSummary: "The planner says the temperature inversion clause limits the remaining hours.",
  };
}

function dependencies(store: AlertBlobStore, twilio: AlertTwilio, overrides: Partial<AlertServiceDependencies> = {}): AlertServiceDependencies {
  return {
    store,
    twilio,
    now: () => NOW,
    fields: async () => new Map([["tift", "Tift"]]),
    validateTank: vi.fn().mockResolvedValue([]),
    plan: vi.fn().mockResolvedValue(evidence()),
    answerWhy: vi.fn().mockResolvedValue("The Folex temperature inversion clause limits the remaining hours."),
    ...overrides,
  };
}

describe("alert verification", () => {
  test("starts Verify without storing a code and creates a subscription only after approval", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const deps = dependencies(store, twilio);
    const started = await startVerification({
      field: "tift",
      tankRegs: ["5481-504", "264-700", "264-418"],
      jobHours: 3,
      phoneNumber: "+15555550123",
      channel: "sms",
    }, config, deps);

    expect(started).toMatchObject({ status: "pending", channel: "sms" });
    expect(twilio.startVerification).toHaveBeenCalledWith("+15555550123", "sms", expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(await store.listActiveSubscriptions()).toEqual([]);
    const pendingText = blob.objects.get(`alerts/pending/${started.verificationId}.json`)!;
    expect(pendingText).toContain("+15555550123");
    expect(pendingText).not.toContain("654321");

    twilio.checkVerification.mockResolvedValueOnce("pending");
    await expect(confirmVerification({ verificationId: started.verificationId, code: "654321" }, config, deps))
      .rejects.toThrow("not approved");
    expect(await store.listActiveSubscriptions()).toEqual([]);

    const confirmed = await confirmVerification({ verificationId: started.verificationId, code: "654321" }, config, deps);
    expect(confirmed).toEqual({ subscriptionId: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "active" });
    expect(twilio.checkVerification).toHaveBeenLastCalledWith("+15555550123", "654321");
    expect(await store.listActiveSubscriptions()).toEqual([
      expect.objectContaining({ id: confirmed.subscriptionId, active: true, phoneNumber: "+15555550123" }),
    ]);
    expect(blob.objects.has(`alerts/pending/${started.verificationId}.json`)).toBe(false);
  });

  test("limits Verify starts and collapses duplicate exact subscriptions", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const deps = dependencies(store, twilio);
    const request = {
      field: "tift",
      tankRegs: ["5481-504", "264-700", "264-418"],
      jobHours: 3,
      phoneNumber: "+15555550123",
    };
    const first = await startVerification(request, config, deps, { clientAddress: "192.0.2.10" });
    const firstConfirmed = await confirmVerification({ verificationId: first.verificationId, code: "654321" }, config, deps);
    const rotatedConfig = { ...config, runSecret: "rotated-run-secret" };
    const second = await startVerification(
      { ...request, tankRegs: [...request.tankRegs].reverse() },
      rotatedConfig,
      deps,
      { clientAddress: "192.0.2.10" },
    );
    const secondConfirmed = await confirmVerification(
      { verificationId: second.verificationId, code: "654321" },
      rotatedConfig,
      deps,
    );
    expect(secondConfirmed.subscriptionId).toBe(firstConfirmed.subscriptionId);
    expect(await store.listActiveSubscriptions()).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) {
      await startVerification(request, config, deps, { clientAddress: "192.0.2.10" });
    }
    await expect(startVerification(request, config, deps, { clientAddress: "192.0.2.10" }))
      .rejects.toMatchObject({ status: 429 });
    expect(twilio.startVerification).toHaveBeenCalledTimes(5);
  });

  test("does not spend Verify capacity on definite failures before a send", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const request = {
      field: "tift",
      tankRegs: ["5481-504"],
      jobHours: 3,
      phoneNumber: "+15555550123",
    };
    const validateTank = vi.fn().mockRejectedValueOnce(new RangeError("not compiled")).mockResolvedValue([]);
    const deps = dependencies(store, twilio, { validateTank });
    await expect(startVerification(request, config, deps, { clientAddress: "192.0.2.20" }))
      .rejects.toMatchObject({ status: 400 });

    const writePending = store.writePending.bind(store);
    vi.spyOn(store, "writePending").mockRejectedValueOnce(new Error("Blob unavailable")).mockImplementation(writePending);
    await expect(startVerification(request, config, deps, { clientAddress: "192.0.2.20" }))
      .rejects.toThrow("Blob unavailable");

    twilio.startVerification.mockRejectedValueOnce(new TwilioVerificationRequestError(true));
    await expect(startVerification(request, config, deps, { clientAddress: "192.0.2.20" }))
      .rejects.toMatchObject({ status: 502 });
    expect([...blob.objects.keys()].filter((key) => key.startsWith("alerts/verify-caps/"))).toEqual([]);
    await expect(startVerification(request, config, deps, { clientAddress: "192.0.2.20" }))
      .resolves.toMatchObject({ status: "pending" });
  });

  test("enforces a global daily Verify start ceiling", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    for (let index = 0; index < VERIFY_STARTS_TOTAL_PER_DAY; index += 1) {
      await expect(store.reserveVerificationAttempt(
        `client-${index}`,
        `phone-${index}`,
        "2026-10-06",
        `attempt-${index}`,
      )).resolves.toMatchObject({ status: "reserved" });
    }
    await expect(store.reserveVerificationAttempt(
      "one-more-client",
      "one-more-phone",
      "2026-10-06",
      "one-more-attempt",
    )).resolves.toEqual({ status: "total-cap" });
  });

  test("never calls a pending, unverified number", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const plan = vi.fn().mockResolvedValue(evidence());
    const deps = dependencies(store, twilio, { plan });
    await startVerification({
      field: "tift",
      tankRegs: ["5481-504"],
      jobHours: 3,
      phoneNumber: "+15555550123",
    }, config, deps);

    await expect(runAlerts(config, deps)).resolves.toMatchObject({ scanned: 0, called: 0 });
    expect(plan).not.toHaveBeenCalled();
    expect(twilio.placeCall).not.toHaveBeenCalled();
  });

  test("sweeps expired pending records during the hourly run", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.writePending({
      schemaVersion: 1,
      id: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-10-06T09:00:00.000Z",
      expiresAt: "2026-10-06T09:10:00.000Z",
      field: "tift",
      tankRegs: ["5481-504"],
      jobHours: 3,
      phoneNumber: "+15555550124",
      phoneHash: phoneLookupHash("+15555550124", config.runSecret),
      channel: "sms",
    });

    await expect(runAlerts(config, dependencies(store, twilio))).resolves.toMatchObject({ scanned: 0 });
    expect(blob.objects.has("alerts/pending/22222222-2222-4222-8222-222222222222.json")).toBe(false);
  });

  test("continues the alert run when pending cleanup fails", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    vi.spyOn(store, "sweepExpiredPending").mockRejectedValueOnce(new Error("Blob throttled"));

    await expect(runAlerts(config, dependencies(store, twilio))).resolves.toMatchObject({
      cleanupFailed: true,
      called: 1,
    });
    expect(twilio.placeCall).toHaveBeenCalledTimes(1);
  });
});

describe("alert run", () => {
  test("starts at the next full hour when a permitted run is already in progress", async () => {
    const replay = JSON.parse(await readFile(path.join(process.cwd(), "public/data/replay/tift.json"), "utf8")) as { periods: unknown[] };
    const nwsFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ properties: { periods: replay.periods } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const planner = await planAlert(subscription(), {
      now: new Date("2026-10-07T17:05:00.000Z"),
      fetchImpl: nwsFetch,
    });

    expect(planner?.calledWindow).toMatchObject({
      start: "2026-10-07T14:00:00-04:00",
      hours: 5,
    });
  });

  test("finds the committed Tift replay window and does not call that window twice", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    const replay = JSON.parse(await readFile(path.join(process.cwd(), "public/data/replay/tift.json"), "utf8")) as { periods: unknown[] };
    const nwsFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ properties: { periods: replay.periods } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const deps = dependencies(store, twilio, {
      plan: (record, input) => planAlert(record, { ...input, fetchImpl: nwsFetch }),
    });

    const first = await runAlerts(config, deps);
    expect(first).toMatchObject({ scanned: 1, called: 1, duplicate: 0, quietHours: false });
    expect(twilio.placeCall).toHaveBeenCalledTimes(1);
    expect(twilio.placeCall).toHaveBeenCalledWith(
      "+15555550123",
      expect.stringMatching(/This is Labelhand[\s\S]*At Tift[\s\S]*Folex 6 EC[\s\S]*Press 9 to stop these calls/),
    );
    const log = await store.readCall(SUBSCRIPTION_ID, callWindowId(SUBSCRIPTION_ID, "2026-10-07T23:00:00.000Z"));
    expect(log?.planner.calledWindow).toMatchObject({ start: "2026-10-07T13:00:00-04:00", end: "2026-10-07T23:00:00.000Z", hours: 6 });

    const second = await runAlerts(config, deps);
    expect(second).toMatchObject({ called: 0, duplicate: 1 });
    expect(twilio.placeCall).toHaveBeenCalledTimes(1);
  });

  test("calls a permitted run once while later hourly runs see it shrink from the front", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    const replay = JSON.parse(await readFile(path.join(process.cwd(), "public/data/replay/tift.json"), "utf8")) as { periods: unknown[] };
    const nwsFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ properties: { periods: replay.periods } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    let clock = new Date("2026-10-06T10:23:00.000Z");
    const deps = dependencies(store, twilio, {
      now: () => clock,
      plan: (record, input) => planAlert(record, { ...input, fetchImpl: nwsFetch }),
    });

    // The recorder fires at minute 23. The run opens 13:00 EDT and lasts through 18:00 EDT.
    const runs = [];
    for (const at of ["2026-10-06T10:23:00.000Z", "2026-10-07T17:23:00.000Z", "2026-10-07T18:23:00.000Z", "2026-10-07T19:23:00.000Z"]) {
      clock = new Date(at);
      runs.push(await runAlerts(config, deps));
    }

    expect(runs.map((run) => run.called)).toEqual([1, 0, 0, 0]);
    expect(runs.slice(1).map((run) => run.duplicate)).toEqual([1, 1, 1]);
    expect(twilio.placeCall).toHaveBeenCalledTimes(1);
  });

  test("skips all planning and calls during Eastern quiet hours", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    const plan = vi.fn().mockResolvedValue(evidence());
    const deps = dependencies(store, twilio, {
      now: () => new Date("2026-10-06T09:59:00.000Z"),
      plan,
    });

    await expect(runAlerts(config, deps)).resolves.toMatchObject({ quietHours: true, scanned: 0, called: 0 });
    expect(plan).not.toHaveBeenCalled();
    expect(twilio.placeCall).not.toHaveBeenCalled();
  });

  test("rechecks quiet hours immediately before placing each call", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-10-07T00:59:58.000Z"))
      .mockReturnValueOnce(new Date("2026-10-07T00:59:59.000Z"))
      .mockReturnValue(new Date("2026-10-07T01:00:00.000Z"));

    await expect(runAlerts(config, dependencies(store, twilio, { now })))
      .resolves.toMatchObject({ quietHours: true, called: 0 });
    expect(twilio.placeCall).not.toHaveBeenCalled();
    expect([...blob.objects.keys()].some((key) => key.startsWith("alerts/log/"))).toBe(false);
    expect([...blob.objects.keys()].some((key) => key.startsWith("alerts/caps/"))).toBe(false);
  });

  test("does not call a subscription stopped while its forecast is being planned", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const record = subscription();
    await store.createSubscription(record);
    const plan = vi.fn().mockImplementation(async () => {
      await store.updateSubscription({ ...record, active: false, unsubscribedAt: NOW.toISOString() });
      return evidence();
    });

    await expect(runAlerts(config, dependencies(store, twilio, { plan })))
      .resolves.toMatchObject({ scanned: 1, called: 0 });
    expect(twilio.placeCall).not.toHaveBeenCalled();
  });

  test("retries a window after a storage failure before the call request", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    const reserveCapacity = store.reserveCapacity.bind(store);
    vi.spyOn(store, "reserveCapacity")
      .mockRejectedValueOnce(new Error("temporary Blob outage"))
      .mockImplementation(reserveCapacity);
    const deps = dependencies(store, twilio);

    await expect(runAlerts(config, deps)).resolves.toMatchObject({ failed: 1, called: 0 });
    await expect(runAlerts(config, deps)).resolves.toMatchObject({ failed: 0, called: 1, duplicate: 0 });
    expect(twilio.placeCall).toHaveBeenCalledTimes(1);
  });

  test("retries a window after Twilio definitely rejects the call request", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    twilio.placeCall.mockRejectedValueOnce(new TwilioCallRequestError(true));
    const deps = dependencies(store, twilio);

    await expect(runAlerts(config, deps)).resolves.toMatchObject({ failed: 1, called: 0 });
    await expect(runAlerts(config, deps)).resolves.toMatchObject({ failed: 0, called: 1, duplicate: 0 });
    expect(twilio.placeCall).toHaveBeenCalledTimes(2);
  });

  test("enforces three calls per subscription per Eastern day", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    await store.createSubscription(subscription());
    let planned = 0;
    const deps = dependencies(store, twilio, {
      plan: vi.fn().mockImplementation(async () => {
        const start = new Date(Date.parse("2026-10-06T12:00:00.000Z") + planned * 4 * 60 * 60 * 1_000).toISOString();
        planned += 1;
        return evidence(start);
      }),
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(runAlerts(config, deps)).resolves.toMatchObject({ called: 1, capped: 0 });
    }
    await expect(runAlerts(config, deps)).resolves.toMatchObject({ called: 0, capped: 1 });
    expect(twilio.placeCall).toHaveBeenCalledTimes(3);
  });

  test("limits one verified phone across multiple subscriptions", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    for (let index = 0; index < 10; index += 1) {
      await store.createSubscription(subscription({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        field: index % 2 === 0 ? "tift" : "hart",
      }));
    }

    await expect(runAlerts(config, dependencies(store, twilio))).resolves.toMatchObject({
      scanned: 10,
      called: 9,
      capped: 1,
    });
    expect(twilio.placeCall).toHaveBeenCalledTimes(9);
  });

  test("enforces thirty calls total per Eastern day", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const day = "2026-10-06";
    for (let index = 0; index < 30; index += 1) {
      const reserved = await store.reserveCapacity(`seed-${index}`, `phone-${index}`, day, `call-${index}`);
      expect(reserved.status).toBe("reserved");
    }
    await store.createSubscription(subscription());
    const deps = dependencies(store, twilio);

    await expect(runAlerts(config, deps)).resolves.toMatchObject({ called: 0, capped: 1 });
    expect(twilio.placeCall).not.toHaveBeenCalled();
  });
});

describe("voice actions", () => {
  test("answers from the stored planner result and stops the subscription", async () => {
    const blob = fakeBlob();
    const store = new AlertBlobStore(config, blob.api);
    const twilio = fakeTwilio();
    const record = subscription();
    await store.createSubscription(record);
    const planner = evidence();
    const id = callWindowId(record.id, planner.calledWindow.end);
    const log: AlertCallLog = {
      schemaVersion: 1,
      id,
      subscriptionId: record.id,
      phoneHash: record.phoneHash,
      createdAt: NOW.toISOString(),
      easternDay: "2026-10-06",
      status: "queued",
      planner,
      twilioCallSid: `CA${"3".repeat(32)}`,
    };
    await store.claimCall(log);
    const answerWhy = vi.fn().mockResolvedValue("The stored Folex inversion clause limits the remaining hours.");
    const deps = dependencies(store, twilio, { answerWhy });

    const answered = await answerVoiceWhy(record.id, id, { Digits: "1" }, config, deps);
    expect(answerWhy).toHaveBeenCalledWith(planner);
    expect(answered.twiml).toContain("The stored Folex inversion clause limits the remaining hours.");

    const stopped = await stopVoiceCalls(record.id, id, config, deps);
    expect(stopped).toContain("Labelhand calls are stopped");
    expect((await store.readSubscription(record.id))?.active).toBe(false);
    expect((await store.readSubscription(record.id))?.phoneNumber).toBeUndefined();
    expect(blob.objects.get(`alerts/subscriptions/${record.id}.json`)).not.toContain(record.phoneNumber);
    expect(await store.listActiveSubscriptions()).toEqual([]);
  });
});
