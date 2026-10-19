import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as confirmPost } from "@/app/api/alerts/confirm/route";
import { POST as runPost } from "@/app/api/alerts/run/route";
import { POST as startPost } from "@/app/api/alerts/start/route";
import { POST as stopPost } from "@/app/api/alerts/voice/stop/route";
import { POST as whyPost } from "@/app/api/alerts/voice/why/route";

function jsonRequest(pathname: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function voiceRequest(pathname: string, signature?: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signature ? { "x-twilio-signature": signature } : {}),
    },
    body: new URLSearchParams({ Digits: "1", CallSid: `CA${"3".repeat(32)}` }),
  });
}

function configure() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"1".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15555550100");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"2".repeat(32)}`);
  vi.stubEnv("ALERTS_RUN_SECRET", "test-run-secret");
  vi.stubEnv("ALERTS_PUBLIC_BASE_URL", "https://labelhand.example.com");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-blob-token");
}

beforeEach(() => {
  for (const name of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "TWILIO_VERIFY_SERVICE_SID",
    "ALERTS_RUN_SECRET",
    "ALERTS_PUBLIC_BASE_URL",
    "BLOB_READ_WRITE_TOKEN",
  ]) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("alerts route boundaries", () => {
  test("returns 503 from every alerts route when production settings are missing", async () => {
    const responses = await Promise.all([
      startPost(jsonRequest("/api/alerts/start", {})),
      confirmPost(jsonRequest("/api/alerts/confirm", {})),
      runPost(jsonRequest("/api/alerts/run", {}, { authorization: "Bearer wrong" })),
      whyPost(voiceRequest("/api/alerts/voice/why")),
      stopPost(voiceRequest("/api/alerts/voice/stop")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
    expect(responses[3].headers.get("content-type")).toContain("application/xml");
    expect(responses[4].headers.get("content-type")).toContain("application/xml");
  });

  test("rejects a bad run bearer before reading Blob", async () => {
    configure();
    const response = await runPost(jsonRequest("/api/alerts/run", {}, { authorization: "Bearer wrong" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized." });
  });

  test("rejects an unsigned or badly signed why webhook with TwiML and 403", async () => {
    configure();
    const pathname = `/api/alerts/voice/why?subscription=11111111-1111-4111-8111-111111111111&call=${"a".repeat(64)}`;
    for (const request of [voiceRequest(pathname), voiceRequest(pathname, "bad-signature")]) {
      const response = await whyPost(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/xml");
      await expect(response.text()).resolves.toContain("Request refused");
    }
  });
});
