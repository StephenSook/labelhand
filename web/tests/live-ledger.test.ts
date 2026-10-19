import { BlobPreconditionFailedError } from "@vercel/blob";
import { describe, expect, test } from "vitest";

import {
  LEDGER_PREFIX,
  PHOTO_LEDGER_PREFIX,
  SHARED_DAILY_PHOTO_READS,
  SHARED_DAILY_COLD_COMPILES,
  SHARED_LIFETIME_COLD_COMPILES,
  ledgerPath,
  photoLedgerPath,
  reserveSharedColdCompile,
  reserveSharedPhotoRead,
  visitorKey,
} from "@/lib/live-ledger";
import { LiveLimitError } from "@/lib/live-limits";

const TOKEN = "vercel_blob_rw_test_token";
const NOW = Date.parse("2026-10-20T15:00:00Z");
const env = { BLOB_READ_WRITE_TOKEN: TOKEN, VERCEL_ENV: "production" };

// A stand-in for the shared Blob store: list pages through stored names, put appends.
function fakeStore(initial: string[] = [], failList = false, failPut = false) {
  const names = [...initial];
  const written: string[] = [];
  const api = {
    list: (async (options?: { cursor?: string; limit?: number; prefix?: string }) => {
      if (failList) throw new Error("blob list failed");
      const start = Number(options?.cursor ?? 0);
      const limit = options?.limit ?? 1_000;
      const matching = options?.prefix
        ? names.filter((pathname) => pathname.startsWith(options.prefix as string))
        : names;
      const page = matching.slice(start, start + limit);
      const next = start + page.length;
      return {
        blobs: page.map((pathname) => ({ pathname })),
        hasMore: next < matching.length,
        cursor: next < matching.length ? String(next) : undefined,
      };
    }) as never,
    put: (async (pathname: string) => {
      if (failPut) throw new Error("blob write failed");
      if (names.includes(pathname)) throw new BlobPreconditionFailedError();
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

function photoEntries(count: number, at: number): string[] {
  return Array.from({ length: count }, (_, index) => photoLedgerPath(at, index));
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

describe("shared photo-read ledger", () => {
  test("a production deployment without the shared store fails closed", async () => {
    const error = await refusal(reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env: { VERCEL_ENV: "production" } }));
    expect(error.status).toBe(503);
    await expect(reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env: {} })).resolves.toBeUndefined();
  });

  test("records photo reads under a separate prefix without the address", async () => {
    const store = fakeStore();
    await reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: store.api });
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatch(new RegExp(`^${PHOTO_LEDGER_PREFIX}2026-10-20/slots/\\d{3}\\.json$`));
    expect(store.written[0]).not.toContain("203.0.113.5");
  });

  test("refuses once the shared photo count is full", async () => {
    const store = fakeStore(photoEntries(SHARED_DAILY_PHOTO_READS, NOW - 3_600_000));
    const error = await refusal(reserveSharedPhotoRead({ ip: "198.51.100.7", now: NOW, env, api: store.api }));
    expect(error.status).toBe(503);
    expect(store.written).toHaveLength(0);
  });

  test("allows only one concurrent reservation for the final daily slot", async () => {
    const store = fakeStore(photoEntries(SHARED_DAILY_PHOTO_READS - 1, NOW));
    const attempts = await Promise.allSettled([
      reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: store.api }),
      reserveSharedPhotoRead({ ip: "198.51.100.7", now: NOW, env, api: store.api }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(store.written).toHaveLength(1);
  });

  test("does not count cold compile records as photo reads", async () => {
    const store = fakeStore(entries(SHARED_DAILY_COLD_COMPILES, NOW - 3_600_000));
    await reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: store.api });
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toContain(PHOTO_LEDGER_PREFIX);
  });

  test("fails closed when the photo ledger cannot be read or written", async () => {
    const readError = await refusal(reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: fakeStore([], true).api }));
    expect(readError.status).toBe(503);
    const writeError = await refusal(reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: fakeStore([], false, true).api }));
    expect(writeError.status).toBe(503);
  });
});
