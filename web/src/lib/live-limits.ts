export const LIMIT_WINDOW_MS = 10 * 60 * 1_000;
export const COLD_COMPILES_PER_WINDOW = 3;
export const CACHE_HITS_PER_WINDOW = 60;
export const DAILY_BUDGET_USD = 2;
export const COMPILE_TOKEN_CEILING = 120_000;
export const MAX_IN_FLIGHT_COLD_COMPILES = 2;

type LimitKind = "cache" | "cold";

interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface ColdCompileOptions<T> {
  sha256: string;
  ip: string;
  work: () => Promise<T>;
  now?: number;
}

export interface ColdCompileResult<T> {
  value: T;
  deduplicated: boolean;
}

export class LiveLimitError extends Error {
  constructor(message: string, readonly status = 429, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "LiveLimitError";
  }
}

const requestWindows = new Map<string, number[]>();
const inFlight = new Map<string, Promise<unknown>>();
let activeColdCompiles = 0;
let budgetDay = "";
let budgetSpentUsd = 0;

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function refreshBudgetDay(now: number): void {
  const currentDay = dayKey(now);
  if (budgetDay === currentDay) return;
  budgetDay = currentDay;
  budgetSpentUsd = 0;
}

export function checkRequestLimit(
  ip: string,
  kind: LimitKind,
  now = Date.now(),
): LimitResult {
  const maximum = kind === "cold" ? COLD_COMPILES_PER_WINDOW : CACHE_HITS_PER_WINDOW;
  const key = `${kind}:${ip || "unknown"}`;
  const cutoff = now - LIMIT_WINDOW_MS;
  const current = (requestWindows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
  if (current.length >= maximum) {
    requestWindows.set(key, current);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current[0] + LIMIT_WINDOW_MS - now) / 1_000)),
    };
  }
  current.push(now);
  requestWindows.set(key, current);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function assertCacheHitAllowed(ip: string, now = Date.now()): void {
  const result = checkRequestLimit(ip, "cache", now);
  if (!result.allowed) {
    throw new LiveLimitError("Too many cached label requests. Try again shortly.", 429, result.retryAfterSeconds);
  }
}

export function assertLiveCompileEnabled(value = process.env.LIVE_COMPILE): void {
  if (value?.trim().toLowerCase() === "off") {
    throw new LiveLimitError("Live label compilation is temporarily disabled.", 503);
  }
}

export function assertDailyBudgetAvailable(now = Date.now()): void {
  refreshBudgetDay(now);
  if (budgetSpentUsd >= DAILY_BUDGET_USD) {
    throw new LiveLimitError("The live label daily budget has been reached. Try again tomorrow.", 503);
  }
}

export function recordCompileSpend(costUsd: number, now = Date.now()): number {
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError("Compile cost must be a non-negative number.");
  refreshBudgetDay(now);
  budgetSpentUsd += costUsd;
  return budgetSpentUsd;
}

export function assertCompileTokenCeiling(totalTokens: number): void {
  if (!Number.isFinite(totalTokens) || totalTokens < 0) throw new TypeError("Compile token use must be a non-negative number.");
  if (totalTokens > COMPILE_TOKEN_CEILING) {
    throw new LiveLimitError(`The live compile exceeded the ${COMPILE_TOKEN_CEILING} token ceiling.`, 422);
  }
}

export async function runColdCompile<T>(options: ColdCompileOptions<T>): Promise<ColdCompileResult<T>> {
  const existing = inFlight.get(options.sha256) as Promise<T> | undefined;
  if (existing) return { value: await existing, deduplicated: true };

  if (activeColdCompiles >= MAX_IN_FLIGHT_COLD_COMPILES) {
    throw new LiveLimitError("The live compiler is busy. Try again shortly.", 429, 10);
  }
  const rate = checkRequestLimit(options.ip, "cold", options.now ?? Date.now());
  if (!rate.allowed) {
    throw new LiveLimitError("Too many cold label compiles. Try again shortly.", 429, rate.retryAfterSeconds);
  }
  assertDailyBudgetAvailable(options.now);

  activeColdCompiles += 1;
  const promise = Promise.resolve().then(options.work);
  inFlight.set(options.sha256, promise);
  try {
    return { value: await promise, deduplicated: false };
  } finally {
    if (inFlight.get(options.sha256) === promise) inFlight.delete(options.sha256);
    activeColdCompiles -= 1;
  }
}

export function resetLiveLimitsForTests(): void {
  requestWindows.clear();
  inFlight.clear();
  activeColdCompiles = 0;
  budgetDay = "";
  budgetSpentUsd = 0;
}
