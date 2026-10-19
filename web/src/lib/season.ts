import type { ForecastPeriod } from "@/engine";
import committedSeasonIndex from "../../public/data/season/index.json";

export type SeasonPointIndex = {
  days: string[];
  issuances: number;
};

export type SeasonIndex = {
  generated_utc: string;
  recorded_span: { first: string; last: string };
  points: Record<string, SeasonPointIndex>;
};

export type SeasonIssuance = {
  fetched_utc: string;
  first_start: string;
  hours: number;
  is_daytime: boolean[];
  temperature_f: Array<number | null>;
  wind_mph: Array<number | null>;
  pop: Array<number | null>;
  start_times?: string[];
  wind_raw?: Array<string | null>;
};

export type SeasonDay = {
  point: string;
  day: string;
  source: string;
  issuances: SeasonIssuance[];
};

class SeasonHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`${url} returned HTTP ${status} ${statusText}`.trim());
  }
}

export class SeasonNotRecordedError extends Error {
  constructor(point: string, day: string) {
    super(`No season forecast was recorded for ${point} on ${day}.`);
    this.name = "SeasonNotRecordedError";
  }
}

export function isSeasonNotRecorded(error: unknown): error is SeasonNotRecordedError {
  return error instanceof SeasonNotRecordedError;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new TypeError(`${path} must be an RFC3339 timestamp`);
  }
  return parsed;
}

function day(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))) {
    throw new TypeError(`${path} must be an ISO date`);
  }
  return parsed;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  return value;
}

function parallel<T>(
  value: unknown,
  path: string,
  hours: number,
  parse: (item: unknown, path: string) => T,
): T[] {
  const values = array(value, path);
  if (values.length !== hours) {
    throw new TypeError(`${path} has ${values.length} values, expected ${hours}`);
  }
  return values.map((item, index) => parse(item, `${path}[${index}]`));
}

function finiteNumberOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number or null`);
  }
  return value;
}

function parseIssuance(value: unknown, path: string): SeasonIssuance {
  const source = record(value, path);
  if (!Number.isInteger(source.hours) || (source.hours as number) <= 0) {
    throw new TypeError(`${path}.hours must be a positive integer`);
  }
  const hours = source.hours as number;
  const isDaytime = parallel(source.is_daytime, `${path}.is_daytime`, hours, (item, itemPath) => {
    if (typeof item !== "boolean") throw new TypeError(`${itemPath} must be boolean`);
    return item;
  });
  const temperature = parallel(source.temperature_f, `${path}.temperature_f`, hours, finiteNumberOrNull);
  const wind = parallel(source.wind_mph, `${path}.wind_mph`, hours, (item, itemPath) => {
    const parsed = finiteNumberOrNull(item, itemPath);
    if (parsed !== null && parsed < 0) throw new TypeError(`${itemPath} must not be negative`);
    return parsed;
  });
  const pop = parallel(source.pop, `${path}.pop`, hours, (item, itemPath) => {
    if (item === null) return null;
    if (!Number.isInteger(item) || (item as number) < 0 || (item as number) > 100) {
      throw new TypeError(`${itemPath} must be an integer from 0 through 100 or null`);
    }
    return item as number;
  });
  const startTimes = source.start_times === undefined
    ? undefined
    : parallel(source.start_times, `${path}.start_times`, hours, timestamp);
  const windRaw = source.wind_raw === undefined
    ? undefined
    : parallel(source.wind_raw, `${path}.wind_raw`, hours, (item, itemPath) => {
        if (item === null || typeof item === "string") return item;
        throw new TypeError(`${itemPath} must be a string or null`);
      });
  for (let index = 0; index < hours; index += 1) {
    if (wind[index] !== null && windRaw?.[index] !== null && windRaw?.[index] !== undefined) {
      throw new TypeError(`${path} wind columns conflict at index ${index}`);
    }
  }

  const firstStart = timestamp(source.first_start, `${path}.first_start`);
  if (startTimes && startTimes[0] !== firstStart) {
    throw new TypeError(`${path}.start_times[0] must equal first_start`);
  }
  return {
    fetched_utc: timestamp(source.fetched_utc, `${path}.fetched_utc`),
    first_start: firstStart,
    hours,
    is_daytime: isDaytime,
    temperature_f: temperature,
    wind_mph: wind,
    pop,
    ...(startTimes ? { start_times: startTimes } : {}),
    ...(windRaw ? { wind_raw: windRaw } : {}),
  };
}

export function parseSeasonIndex(value: unknown): SeasonIndex {
  const source = record(value, "season index");
  const span = record(source.recorded_span, "season index.recorded_span");
  const pointSource = record(source.points, "season index.points");
  const points: Record<string, SeasonPointIndex> = {};
  for (const [key, value] of Object.entries(pointSource)) {
    if (!key) throw new TypeError("season index contains an empty point key");
    const point = record(value, `season index.points.${key}`);
    const days = array(point.days, `season index.points.${key}.days`).map((value, index) =>
      day(value, `season index.points.${key}.days[${index}]`),
    );
    if (days.length === 0) throw new TypeError(`season index.points.${key}.days must not be empty`);
    if (!Number.isInteger(point.issuances) || (point.issuances as number) < 0) {
      throw new TypeError(`season index.points.${key}.issuances must be a nonnegative integer`);
    }
    points[key] = { days, issuances: point.issuances as number };
  }
  if (Object.keys(points).length === 0) throw new TypeError("season index.points must not be empty");
  return {
    generated_utc: timestamp(source.generated_utc, "season index.generated_utc"),
    recorded_span: {
      first: timestamp(span.first, "season index.recorded_span.first"),
      last: timestamp(span.last, "season index.recorded_span.last"),
    },
    points,
  };
}

export function parseSeasonDay(value: unknown): SeasonDay {
  const source = record(value, "season day");
  const issuances = array(source.issuances, "season day.issuances").map((value, index) =>
    parseIssuance(value, `season day.issuances[${index}]`),
  );
  if (issuances.length === 0) throw new TypeError("season day.issuances must not be empty");
  return {
    point: string(source.point, "season day.point"),
    day: day(source.day, "season day.day"),
    source: string(source.source, "season day.source"),
    issuances,
  };
}

const COMMITTED_SEASON_INDEX = parseSeasonIndex(committedSeasonIndex);

async function fetchSeasonJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new SeasonHttpError(url, response.status, response.statusText);
  return await response.json() as unknown;
}

function timestampMinimum(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function timestampMaximum(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

// The committed index is the boundary. Only whole UTC days after each point's
// committed last day are added from Object Storage.
export function mergeSeasonIndexes(committed: SeasonIndex, remote: SeasonIndex): SeasonIndex {
  const points: Record<string, SeasonPointIndex> = {};
  let hasNewerDay = false;
  for (const point of new Set([...Object.keys(committed.points), ...Object.keys(remote.points)])) {
    const base = committed.points[point];
    const live = remote.points[point];
    const baseDays = base?.days ?? [];
    const boundary = [...baseDays].sort().at(-1);
    const newerDays = live?.days.filter((candidate) => boundary === undefined || candidate > boundary) ?? [];
    hasNewerDay = hasNewerDay || newerDays.length > 0;
    const days = [...new Set([...baseDays, ...newerDays])].sort();
    if (days.length === 0) continue;
    points[point] = {
      days,
      issuances: Math.max(base?.issuances ?? 0, live?.issuances ?? 0),
    };
  }
  if (!hasNewerDay) return committed;
  return {
    generated_utc: timestampMaximum(committed.generated_utc, remote.generated_utc),
    recorded_span: {
      first: timestampMinimum(committed.recorded_span.first, remote.recorded_span.first),
      last: timestampMaximum(committed.recorded_span.last, remote.recorded_span.last),
    },
    points,
  };
}

export async function fetchMergedSeasonIndex(): Promise<SeasonIndex> {
  const committed = parseSeasonIndex(await fetchSeasonJson("/data/season/index.json"));
  try {
    const remote = parseSeasonIndex(await fetchSeasonJson("/api/season/index.json"));
    return mergeSeasonIndexes(committed, remote);
  } catch (error) {
    if (canUseStaticFallback(error)) return committed;
    throw error;
  }
}

function canUseStaticFallback(error: unknown): error is SeasonHttpError {
  return error instanceof SeasonHttpError && (error.status === 404 || error.status === 503);
}

function newerThanCommitted(point: string, requestedDay: string): boolean {
  const lastCommitted = [...(COMMITTED_SEASON_INDEX.points[point]?.days ?? [])].sort().at(-1);
  return lastCommitted !== undefined && requestedDay > lastCommitted;
}

function checkedSeasonDay(value: unknown, point: string, requestedDay: string): SeasonDay {
  const parsed = parseSeasonDay(value);
  if (parsed.point !== point || parsed.day !== requestedDay) {
    throw new TypeError(`season day identity did not match ${point}/${requestedDay}`);
  }
  return parsed;
}

function addHoursPreservingOffset(value: string, hours: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError(`first_start cannot be expanded: ${value}`);
  const [, year, month, date, hour, minute, second, fraction = "", offset] = match;
  const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date), Number(hour) + hours, Number(minute), Number(second)));
  return `${local.toISOString().slice(0, 19)}${fraction}${offset}`;
}

export function issuanceToPeriods(issuance: SeasonIssuance): ForecastPeriod[] {
  return Array.from({ length: issuance.hours }, (_, index) => {
    const windRaw = issuance.wind_raw?.[index];
    const windMph = issuance.wind_mph[index];
    const period: ForecastPeriod = {
      startTime: issuance.start_times?.[index] ?? addHoursPreservingOffset(issuance.first_start, index),
      isDaytime: issuance.is_daytime[index],
      temperature: issuance.temperature_f[index],
      probabilityOfPrecipitation: {
        unitCode: "wmoUnit:percent",
        value: issuance.pop[index],
      },
    };
    if (windRaw !== undefined && windRaw !== null) {
      period.windSpeed = windRaw;
    } else if (windMph !== null) {
      period.windSpeed = `${windMph} mph`;
    }
    return period;
  });
}

export async function fetchSeasonDay(point: string, day: string): Promise<SeasonDay> {
  const suffix = `${encodeURIComponent(point)}/${encodeURIComponent(day)}.json`;
  const staticUrl = `/data/season/${suffix}`;
  if (!newerThanCommitted(point, day)) {
    try {
      return checkedSeasonDay(await fetchSeasonJson(staticUrl), point, day);
    } catch (error) {
      if (error instanceof SeasonHttpError && error.status === 404) {
        throw new SeasonNotRecordedError(point, day);
      }
      throw error;
    }
  }

  let remoteError: unknown;
  try {
    return checkedSeasonDay(await fetchSeasonJson(`/api/season/${suffix}`), point, day);
  } catch (error) {
    if (!canUseStaticFallback(error)) throw error;
    remoteError = error;
  }
  try {
    return checkedSeasonDay(await fetchSeasonJson(staticUrl), point, day);
  } catch (staticError) {
    if (staticError instanceof SeasonHttpError && staticError.status === 404) {
      if (remoteError instanceof SeasonHttpError && remoteError.status === 404) {
        throw new SeasonNotRecordedError(point, day);
      }
      throw remoteError;
    }
    throw staticError;
  }
}
