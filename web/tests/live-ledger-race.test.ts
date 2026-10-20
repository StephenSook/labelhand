import { BlobError } from "@vercel/blob";
import { describe, expect, test, vi } from "vitest";

// Start the slot scan at slot 0 so the race below always hits the same slot first.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => "00000000-0000-4000-8000-000000000000" };
});

import { SHARED_DAILY_PHOTO_READS, photoLedgerPath, reserveSharedPhotoRead } from "@/lib/live-ledger";

const TOKEN = "vercel_blob_rw_test_token";
const NOW = Date.parse("2026-10-20T15:00:00Z");
const env = { BLOB_READ_WRITE_TOKEN: TOKEN, VERCEL_ENV: "production" };
const ALREADY_EXISTS = "This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.";

// Another instance takes `raced` after our first listing and before our put. The real store
// then refuses our put with a plain BlobError, and later listings show the slot as taken.
function racedStore(occupied: string[], raced: string) {
  const names = [...occupied];
  const written: string[] = [];
  let listings = 0;
  const api = {
    list: (async (options?: { prefix?: string; limit?: number }) => {
      listings += 1;
      const visible = listings === 1 ? names : [...names, raced];
      const matching = options?.prefix ? visible.filter((pathname) => pathname.startsWith(options.prefix as string)) : visible;
      return { blobs: matching.slice(0, options?.limit ?? 1_000).map((pathname) => ({ pathname })), hasMore: false };
    }) as never,
    put: (async (pathname: string) => {
      if (pathname === raced || names.includes(pathname)) throw new BlobError(ALREADY_EXISTS);
      names.push(pathname);
      written.push(pathname);
      return { pathname };
    }) as never,
  };
  return { api, written };
}

describe("shared photo-read ledger under a race", () => {
  test("moves to the next free slot when another instance took the chosen one", async () => {
    const occupied = Array.from({ length: SHARED_DAILY_PHOTO_READS - 2 }, (_, index) => photoLedgerPath(NOW, index + 2));
    const store = racedStore(occupied, photoLedgerPath(NOW, 0));
    await reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: store.api });
    expect(store.written).toEqual([photoLedgerPath(NOW, 1)]);
  });

  test("still fails closed when the put fails and the slot is not taken", async () => {
    const store = racedStore([], "ledger/photo/never-listed.json");
    const failing = {
      list: store.api.list,
      put: (async () => {
        throw new BlobError("Blob store unavailable");
      }) as never,
    };
    await expect(reserveSharedPhotoRead({ ip: "203.0.113.5", now: NOW, env, api: failing })).rejects.toMatchObject({ status: 503 });
  });
});
