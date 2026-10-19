import compilerSpec from "./compiler/spec.generated.json";

export const LIMIT_WINDOW_MS = 10 * 60 * 1_000;
export const COLD_COMPILES_PER_WINDOW = 3;
export const CACHE_HITS_PER_WINDOW = 60;
export const PHOTO_READS_PER_WINDOW = 10;
export const DAILY_BUDGET_USD = 2;
export const COMPILE_TOKEN_CEILING = 120_000;
export const LIVE_COMPILE_READINGS = 3;
export const MAX_IN_FLIGHT_COLD_COMPILES = 2;

const MAX_TOKEN_PRICE_PER_MILLION = Math.max(...Object.values(compilerSpec.PRICES).flat());
export const MAX_COMPILE_COST_USD = COMPILE_TOKEN_CEILING * MAX_TOKEN_PRICE_PER_MILLION / 1_000_000;
// Three readings at $0.36 each reserve $1.08 per live compile against the existing $2 daily budget.
const MAX_LIVE_COMPILE_COST_USD = LIVE_COMPILE_READINGS * MAX_COMPILE_COST_USD;

type LimitKind = "cache" | "cold" | "photo";

interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface ColdCompileOptions<T> {
  sha256: string;
  ip: string;
  work: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  now?: number;
  coldRateReserved?: boolean;
  requestRateReserved?: boolean;
}

interface BudgetReservation {
  day: string;
  amount: number;
}

interface InFlightEntry {
  promise: Promise<unknown>;
  controller: AbortController;
  consumers: Set<symbol>;
  settled: boolean;
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
const inFlight = new Map<string, InFlightEntry>();
let activeColdCompiles = 0;
let budgetDay = "";
let budgetSpentUsd = 0;
let budgetReservedUsd = 0;

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function refreshBudgetDay(now: number): void {
  const currentDay = dayKey(now);
  if (budgetDay === currentDay) return;
  budgetDay = currentDay;
  budgetSpentUsd = 0;
  budgetReservedUsd = 0;
}

function reservationError(): LiveLimitError {
  return new LiveLimitError("The live label daily budget has been reached. Try again tomorrow.", 503);
}

function reserveCompileBudget(now: number): BudgetReservation {
  refreshBudgetDay(now);
  if (budgetSpentUsd + budgetReservedUsd + MAX_LIVE_COMPILE_COST_USD > DAILY_BUDGET_USD) {
    throw reservationError();
  }
  budgetReservedUsd += MAX_LIVE_COMPILE_COST_USD;
  return { day: budgetDay, amount: MAX_LIVE_COMPILE_COST_USD };
}

function releaseCompileBudget(reservation: BudgetReservation): void {
  if (budgetDay !== reservation.day) return;
  budgetReservedUsd = Math.max(0, budgetReservedUsd - reservation.amount);
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new LiveLimitError("The live compile request was cancelled.", 499);
}

function waitForEntry<T>(entry: InFlightEntry, signal?: AbortSignal): Promise<T> {
  const consumer = Symbol("live-compile-consumer");
  entry.consumers.add(consumer);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const detach = (reason?: Error) => {
      if (finished) return;
      finished = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      entry.consumers.delete(consumer);
      if (!entry.settled && entry.consumers.size === 0 && !entry.controller.signal.aborted) {
        entry.controller.abort(reason ?? new LiveLimitError("The live compile has no remaining subscribers.", 499));
      }
    };
    const onAbort = () => {
      const error = signal ? signalError(signal) : new LiveLimitError("The live compile request was cancelled.", 499);
      detach(error);
      reject(error);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        detach();
        resolve(value as T);
      },
      (error: unknown) => {
        detach();
        reject(error);
      },
    );
  });
}

export function checkRequestLimit(
  ip: string,
  kind: LimitKind,
  now = Date.now(),
): LimitResult {
  const maximum = kind === "cold"
    ? COLD_COMPILES_PER_WINDOW
    : kind === "photo"
      ? PHOTO_READS_PER_WINDOW
      : CACHE_HITS_PER_WINDOW;
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
    throw new LiveLimitError("Too many label requests. Try again shortly.", 429, result.retryAfterSeconds);
  }
}

export function assertColdCompileAllowed(ip: string, now = Date.now()): void {
  const result = checkRequestLimit(ip, "cold", now);
  if (!result.allowed) {
    throw new LiveLimitError("Too many cold label compiles. Try again shortly.", 429, result.retryAfterSeconds);
  }
}

export function assertPhotoReadAllowed(ip: string, now = Date.now()): void {
  const result = checkRequestLimit(ip, "photo", now);
  if (!result.allowed) {
    throw new LiveLimitError("Too many label photo reads. Try again shortly.", 429, result.retryAfterSeconds);
  }
}

export function assertLiveCompileEnabled(value = process.env.LIVE_COMPILE): void {
  if (value?.trim().toLowerCase() === "off") {
    throw new LiveLimitError("Live label compilation is temporarily disabled.", 503);
  }
}

export function assertLivePhotoEnabled(value = process.env.LIVE_PHOTO): void {
  if (value?.trim().toLowerCase() === "off") {
    throw new LiveLimitError("Label photo reading is temporarily disabled.", 503);
  }
}

export function assertDailyBudgetAvailable(now = Date.now()): void {
  refreshBudgetDay(now);
  if (budgetSpentUsd + budgetReservedUsd + MAX_LIVE_COMPILE_COST_USD > DAILY_BUDGET_USD) {
    throw reservationError();
  }
}

export function recordCompileSpend(costUsd: number, now = Date.now()): number {
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError("Compile cost must be a non-negative number.");
  refreshBudgetDay(now);
  budgetSpentUsd += costUsd;
  return budgetSpentUsd;
}

export function assertCompileTokenCeiling(totalTokens: number, readings = 1): void {
  if (!Number.isFinite(totalTokens) || totalTokens < 0) throw new TypeError("Compile token use must be a non-negative number.");
  if (!Number.isInteger(readings) || readings < 1 || readings > LIVE_COMPILE_READINGS) {
    throw new TypeError(`Compile readings must be an integer from 1 through ${LIVE_COMPILE_READINGS}.`);
  }
  const ceiling = COMPILE_TOKEN_CEILING * readings;
  if (totalTokens > ceiling) {
    throw new LiveLimitError(`The live compile exceeded the ${ceiling} token ceiling.`, 422);
  }
}

export async function runColdCompile<T>(options: ColdCompileOptions<T>): Promise<ColdCompileResult<T>> {
  if (options.signal?.aborted) throw signalError(options.signal);
  const existing = inFlight.get(options.sha256);
  if (existing) {
    if (!options.requestRateReserved) assertCacheHitAllowed(options.ip, options.now);
    return { value: await waitForEntry<T>(existing, options.signal), deduplicated: true };
  }

  if (activeColdCompiles >= MAX_IN_FLIGHT_COLD_COMPILES) {
    throw new LiveLimitError("The live compiler is busy. Try again shortly.", 429, 10);
  }
  const now = options.now ?? Date.now();
  const reservation = reserveCompileBudget(now);
  try {
    if (!options.coldRateReserved) assertColdCompileAllowed(options.ip, now);
  } catch (error) {
    releaseCompileBudget(reservation);
    throw error;
  }

  activeColdCompiles += 1;
  const controller = new AbortController();
  const entry: InFlightEntry = {
    promise: Promise.resolve(),
    controller,
    consumers: new Set(),
    settled: false,
  };
  const workPromise = Promise.resolve().then(() => options.work(controller.signal));
  entry.promise = workPromise.then(
    (value) => {
      entry.settled = true;
      return value;
    },
    (error: unknown) => {
      entry.settled = true;
      throw error;
    },
  ).finally(() => {
    if (inFlight.get(options.sha256) === entry) inFlight.delete(options.sha256);
    activeColdCompiles = Math.max(0, activeColdCompiles - 1);
    releaseCompileBudget(reservation);
  });
  void entry.promise.catch(() => undefined);
  inFlight.set(options.sha256, entry);
  return { value: await waitForEntry<T>(entry, options.signal), deduplicated: false };
}

export function resetLiveLimitsForTests(): void {
  for (const entry of inFlight.values()) {
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new LiveLimitError("The live compile limit state was reset.", 499));
    }
  }
  requestWindows.clear();
  inFlight.clear();
  activeColdCompiles = 0;
  budgetDay = "";
  budgetSpentUsd = 0;
  budgetReservedUsd = 0;
}
