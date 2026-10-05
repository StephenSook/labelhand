import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "@/app/api/agent/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.4" },
    body: JSON.stringify(body),
  });
}

describe("agent route validation", () => {
  beforeEach(() => {
    vi.stubEnv("NEBIUS_API_KEY", "test-key-that-is-never-sent");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("rejects too many messages", async () => {
    const response = await POST(request({ messages: Array.from({ length: 15 }, () => ({ role: "user", content: "hello" })) }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("at most 14") });
  });

  test("rejects an unknown tool", async () => {
    const response = await POST(request({
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "run_shell", arguments: "{}" } }],
      }],
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("unknown tool") });
  });

  test("rejects an oversized message body", async () => {
    const response = await POST(request({ messages: [{ role: "user", content: "x".repeat(24_001) }] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("24,000") });
  });

  test("returns 503 when the key is missing", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "");
    const response = await POST(request({ messages: [{ role: "user", content: "hello" }] }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "The model is not configured on this deployment",
      status: 503,
    });
  });
});
