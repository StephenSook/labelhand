import { describe, expect, test } from "vitest";

import {
  LEDGER_PREFIX,
  SHARED_DAILY_COLD_COMPILES,
  SHARED_LIFETIME_COLD_COMPILES,
  ledgerPath,
  reserveSharedColdCompile,
  visitorKey,
} from "@/lib/live-ledger";
import { LiveLimitError } from "@/lib/live-limits";

const TOKEN = "vercel_blob_rw_test_token";
const NOW = Date.parse("2026-10-20T15:00:00Z");
const env = { BLOB_READ_WRITE_TOKEN: TOKEN, VERCEL_ENV: "production" };

// A stand-in for the shared Blob store: list pages through stored names, put appends.
function fakeStore(initial: string[] = [], failList = false) {
  const names = [...initial];
  const written: string[] = [];
  const api = {
    list: (async (options?: { cursor?: string; limit?: number }) => {
      if (failList) throw new Error("blob list failed");
      const start = Number(options?.cursor ?? 0);
      const limit = options?.limit ?? 1_000;
      const page = names.slice(start, start + limit);
      const next = start + page.length;
      return {
        blobs: page.map((pathname) => ({ pathname })),
        hasMore: next < names.length,
        cursor: next < names.length ? String(next) : undefined,
      };
    }) as never,
    put: (async (pathname: string) => {
      names.push(pathname);
      written.push(pathname);
      return { pathname };
    }) as never,
  };
  return { api, written };
}

function entries(count: number, at: number, visitor = "0123456789abcdef"): string[] {
  return Array.from({ length: count }, (_, index) => ledgerPath(at - index * 1_000, visitor, `0000000${index}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`));
}

async function refusal(promise: Promise<void>): Promise<LiveLimitError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LiveLimitError);
  return error as LiveLimitError;
}

describe("shared cold-compile ledger", () => {
  test("a production deployment without the shared store refuses instead of compiling without a limit", async () => {
    const error = await refusal(reserveSharedColdCompile({ ip: "203.0.113.5", now: NOW, env: { VERCEL_ENV: "production" } }));
    expect(error.status).toBe(503);
    await expect(reserveSharedColdCompile({ ip: "203.0.113.5", now: NOW, env: {} })).resolves.toBeUndefined();
  });

  test("records one entry per cold compile, keyed by a hash of the visitor and never the address", async () => {
    const store = fakeStore();
    await reserveSharedColdCompile({ ip: "203.0.113.5", now: NOW, env, api: store.api });
    expect(store.written).toHaveLength(1);
    expect(store.written[0].startsWith(`${LEDGER_PREFIX}2026-10-20/${NOW}-${visitorKey("203.0.113.5", TOKEN)}-`)).toBe(true);
    expect(store.written[0]).not.toContain("203.0.113.5");
  });

  test("refuses once today's shared count is full, whichever instance wrote it", async () => {
    const store = fakeStore(entries(SHARED_DAILY_COLD_COMPILES, NOW - 3_600_000));
    const error = await refusal(reserveSharedColdCompile({ ip: "198.51.100.7", now: NOW, env, api: store.api }));
    expect(error.status).toBe(503);
    expect(store.written).toHaveLength(0);
  });

  test("yesterday's entries do not count toward today's cap", async () => {
    const store = fakeStore(entries(SHARED_DAILY_COLD_COMPILES, NOW - 86_400_000));
    await reserveSharedColdCompile({ ip: "198.51.100.7", now: NOW, env, api: store.api });
    expect(store.written).toHaveLength(1);
  });

  test("refuses once the lifetime allowance is used, across days", async () => {
    const days = Array.from({ length: 10 }, (_, day) => entries(SHARED_LIFETIME_COLD_COMPILES / 10, NOW - (day + 1) * 86_400_000)).flat();
    const store = fakeStore(days);
    const error = await refusal(reserveSharedColdCompile({ ip: "198.51.100.7", now: NOW, env, api: store.api }));
    expect(error.status).toBe(503);
  });

  test("limits one visitor across instances without limiting another visitor", async () => {
    const visitor = visitorKey("203.0.113.5", TOKEN);
    const store = fakeStore(entries(3, NOW - 60_000, visitor));
    const error = await refusal(reserveSharedColdCompile({ ip: "203.0.113.5", now: NOW, env, api: store.api }));
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    await reserveSharedColdCompile({ ip: "198.51.100.7", now: NOW, env, api: store.api });
    expect(store.written).toHaveLength(1);
  });

  test("an unreadable ledger fails closed", async () => {
    const store = fakeStore([], true);
    const error = await refusal(reserveSharedColdCompile({ ip: "203.0.113.5", now: NOW, env, api: store.api }));
    expect(error.status).toBe(503);
  });
});
