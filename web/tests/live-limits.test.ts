import { beforeEach, describe, expect, test } from "vitest";

import {
  assertCacheHitAllowed,
  assertColdCompileAllowed,
  assertCompileTokenCeiling,
  assertDailyBudgetAvailable,
  assertLiveCompileEnabled,
  CACHE_HITS_PER_WINDOW,
  COLD_COMPILES_PER_WINDOW,
  COMPILE_TOKEN_CEILING,
  DAILY_BUDGET_USD,
  LiveLimitError,
  MAX_COMPILE_COST_USD,
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

  test("can reserve a cold request before upstream work starts", () => {
    for (let index = 0; index < COLD_COMPILES_PER_WINDOW; index += 1) {
      expect(() => assertColdCompileAllowed("192.0.2.3", 10_000)).not.toThrow();
    }
    expect(() => assertColdCompileAllowed("192.0.2.3", 10_000)).toThrow(LiveLimitError);
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

  test("reserves worst-case cost so concurrent compiles cannot overshoot the budget", async () => {
    expect(MAX_COMPILE_COST_USD).toBeCloseTo(0.36);
    recordCompileSpend(1.3, Date.UTC(2026, 9, 19));
    let release: ((value: string) => void) | undefined;
    const first = runColdCompile({
      sha256: "budget-one",
      ip: "one",
      now: Date.UTC(2026, 9, 19),
      work: () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    });
    await Promise.resolve();
    await expect(runColdCompile({
      sha256: "budget-two",
      ip: "two",
      now: Date.UTC(2026, 9, 19),
      work: async () => "wrong",
    })).rejects.toThrowError(/budget/);
    release?.("done");
    await expect(first).resolves.toMatchObject({ value: "done" });
  });

  test("keeps shared work alive while another subscriber remains", async () => {
    const owner = new AbortController();
    const follower = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    let release: ((value: string) => void) | undefined;
    const first = runColdCompile({
      sha256: "subscribers",
      ip: "owner",
      signal: owner.signal,
      work: (signal) => {
        sharedSignal = signal;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });
    await Promise.resolve();
    const second = runColdCompile({
      sha256: "subscribers",
      ip: "follower",
      signal: follower.signal,
      work: async () => "wrong",
    });
    owner.abort(new Error("owner left"));
    await expect(first).rejects.toThrow("owner left");
    expect(sharedSignal?.aborted).toBe(false);
    release?.("shared");
    await expect(second).resolves.toEqual({ value: "shared", deduplicated: true });
  });

  test("aborts shared work when its final subscriber leaves", async () => {
    const caller = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const result = runColdCompile({
      sha256: "sole-subscriber",
      ip: "owner",
      signal: caller.signal,
      work: (signal) => {
        sharedSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await Promise.resolve();
    caller.abort(new Error("client left"));
    await expect(result).rejects.toThrow("client left");
    expect(sharedSignal?.aborted).toBe(true);
  });

  test("enforces the kill switch, daily ledger, and token ceiling", () => {
    expect(() => assertLiveCompileEnabled("off")).toThrowError(/disabled/);
    expect(recordCompileSpend(DAILY_BUDGET_USD, Date.UTC(2026, 9, 19))).toBe(DAILY_BUDGET_USD);
    expect(() => assertDailyBudgetAvailable(Date.UTC(2026, 9, 19))).toThrowError(/budget/);
    expect(() => assertCompileTokenCeiling(COMPILE_TOKEN_CEILING + 1)).toThrowError(/token ceiling/);
  });
});
