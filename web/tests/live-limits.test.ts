import { beforeEach, describe, expect, test } from "vitest";

import {
  assertCacheHitAllowed,
  assertCompileTokenCeiling,
  assertDailyBudgetAvailable,
  assertLiveCompileEnabled,
  CACHE_HITS_PER_WINDOW,
  COLD_COMPILES_PER_WINDOW,
  COMPILE_TOKEN_CEILING,
  DAILY_BUDGET_USD,
  LiveLimitError,
  recordCompileSpend,
  resetLiveLimitsForTests,
  runColdCompile,
} from "@/lib/live-limits";

beforeEach(() => resetLiveLimitsForTests());

describe("live compile limits", () => {
  test("allows three cold compiles per IP in ten minutes", async () => {
    for (let index = 0; index < COLD_COMPILES_PER_WINDOW; index += 1) {
      await expect(runColdCompile({
        sha256: String(index),
        ip: "192.0.2.1",
        now: 1_000,
        work: async () => index,
      })).resolves.toMatchObject({ value: index, deduplicated: false });
    }
    await expect(runColdCompile({
      sha256: "blocked",
      ip: "192.0.2.1",
      now: 1_000,
      work: async () => 4,
    })).rejects.toMatchObject({ status: 429 });
  });

  test("allows sixty cache hits and then reports the retry window", () => {
    for (let index = 0; index < CACHE_HITS_PER_WINDOW; index += 1) {
      expect(() => assertCacheHitAllowed("192.0.2.2", 10_000)).not.toThrow();
    }
    expect(() => assertCacheHitAllowed("192.0.2.2", 10_000)).toThrow(LiveLimitError);
  });

  test("deduplicates a sha without consuming a second cold slot", async () => {
    let release: ((value: string) => void) | undefined;
    const work = () => new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = runColdCompile({ sha256: "same", ip: "one", work });
    const second = runColdCompile({ sha256: "same", ip: "two", work: async () => "wrong" });
    await Promise.resolve();
    release?.("shared");
    expect(await first).toEqual({ value: "shared", deduplicated: false });
    expect(await second).toEqual({ value: "shared", deduplicated: true });
  });

  test("caps distinct in-flight cold compiles at two", async () => {
    const never = () => new Promise<string>(() => undefined);
    void runColdCompile({ sha256: "one", ip: "one", work: never });
    void runColdCompile({ sha256: "two", ip: "two", work: never });
    await expect(runColdCompile({ sha256: "three", ip: "three", work: async () => "three" }))
      .rejects.toMatchObject({ status: 429 });
  });

  test("enforces the kill switch, daily ledger, and token ceiling", () => {
    expect(() => assertLiveCompileEnabled("off")).toThrowError(/disabled/);
    expect(recordCompileSpend(DAILY_BUDGET_USD, Date.UTC(2026, 9, 19))).toBe(DAILY_BUDGET_USD);
    expect(() => assertDailyBudgetAvailable(Date.UTC(2026, 9, 19))).toThrowError(/budget/);
    expect(() => assertCompileTokenCeiling(COMPILE_TOKEN_CEILING + 1)).toThrowError(/token ceiling/);
  });
});
