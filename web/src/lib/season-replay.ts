import { evaluate as engineEvaluate, type Rule } from "@/engine";
import type { PlannerHour, ReplayForecast } from "@/lib/planner-data";
import { fetchJson } from "@/lib/planner-data";
import {
  fetchSeasonDay,
  issuanceToPeriods,
  parseSeasonIndex,
  type SeasonDay,
  type SeasonIndex,
  type SeasonIssuance,
} from "@/lib/season";
import { forecastPermittedWindows, type ForecastWindow } from "@/lib/windows";

// The recorder saved every hourly NWS forecast since 2026-10-05. The season strip shows one
// forecast per day: the first one issued at or after 7 AM Eastern, the forecast an applicator
// reads before deciding the day.
export const MORNING_HOUR_EASTERN = 7;
export const STABILITY_LOOKBACK = 12;
const PLANNER_HOURS = 156;
const ONE_HOUR_MS = 60 * 60 * 1000;

export type Evaluate = (rules: Rule[], periods: ReplayForecast["periods"], lat: number, lon: number, hours: number) => Promise<unknown>;

export type ScoredIssuance = {
  day: string;
  fetchedUtc: string;
  permittedHours: number;
  windows: ForecastWindow[];
};

export type Stability = {
  held: number;
  compared: number;
};

const easternHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function easternHourOf(utc: string): number {
  return Number(easternHour.format(new Date(utc)));
}

// Day files are UTC days, so each one also holds the previous evening's Eastern forecasts
// (00:00 to 04:00 UTC). A morning must match the file's date in Eastern time as well.
export function morningIssuance(day: SeasonDay): SeasonIssuance {
  const ordered = [...day.issuances].sort((a, b) => Date.parse(a.fetched_utc) - Date.parse(b.fetched_utc));
  return ordered.find((issuance) =>
    easternDate.format(new Date(issuance.fetched_utc)) === day.day
    && easternHourOf(issuance.fetched_utc) >= MORNING_HOUR_EASTERN,
  ) ?? ordered.at(-1)!;
}

export function toReplay(issuance: SeasonIssuance): ReplayForecast {
  return { forecast_fetched_utc: issuance.fetched_utc, periods: issuanceToPeriods(issuance) };
}

async function plannerHours(
  issuance: SeasonIssuance,
  rules: Rule[],
  lat: number,
  lon: number,
  evaluate: Evaluate,
): Promise<PlannerHour[]> {
  const periods = issuanceToPeriods(issuance);
  return await evaluate(rules, periods, lat, lon, Math.min(PLANNER_HOURS, periods.length)) as PlannerHour[];
}

export async function scoreIssuance(
  day: string,
  issuance: SeasonIssuance,
  rules: Rule[],
  lat: number,
  lon: number,
  jobHours: number,
  evaluate: Evaluate = engineEvaluate,
): Promise<ScoredIssuance> {
  const hours = await plannerHours(issuance, rules, lat, lon, evaluate);
  return {
    day,
    fetchedUtc: issuance.fetched_utc,
    permittedHours: hours.filter((hour) => hour.state === "PERMITTED").length,
    windows: forecastPermittedWindows(hours, jobHours),
  };
}

// Most fitting windows first, then most forecast-permitted hours, then the earliest morning.
export function bestScored(scored: ScoredIssuance[]): ScoredIssuance | undefined {
  return [...scored].sort((a, b) =>
    b.windows.length - a.windows.length
    || b.permittedHours - a.permittedHours
    || Date.parse(a.fetchedUtc) - Date.parse(b.fetchedUtc),
  )[0];
}

// How many of the forecasts issued before this one already permitted every hour of the window.
// A forecast that does not reach the whole window cannot vote, so it is left out of `compared`.
export async function windowStability(
  window: ForecastWindow,
  earlier: SeasonIssuance[],
  rules: Rule[],
  lat: number,
  lon: number,
  evaluate: Evaluate = engineEvaluate,
): Promise<Stability> {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const wanted = Math.round((end - start) / ONE_HOUR_MS);
  let held = 0;
  let compared = 0;
  for (const issuance of earlier) {
    const hours = await plannerHours(issuance, rules, lat, lon, evaluate);
    const inside = hours.filter((hour) => {
      const time = Date.parse(hour.start);
      return time >= start && time < end;
    });
    if (inside.length !== wanted) continue;
    compared += 1;
    if (inside.every((hour) => hour.state === "PERMITTED")) held += 1;
  }
  return { held, compared };
}

export async function fetchSeasonIndex(): Promise<SeasonIndex> {
  return parseSeasonIndex(await fetchJson<unknown>("/data/season/index.json"));
}

// The issuances recorded before `fetchedUtc` for one point, newest first, at most `limit`.
export async function earlierIssuances(
  point: string,
  index: SeasonIndex,
  fetchedUtc: string,
  limit = STABILITY_LOOKBACK,
  load: (point: string, day: string) => Promise<SeasonDay> = fetchSeasonDay,
): Promise<SeasonIssuance[]> {
  const days = [...(index.points[point]?.days ?? [])].sort().reverse();
  const cutoff = Date.parse(fetchedUtc);
  const found: SeasonIssuance[] = [];
  for (const day of days) {
    // Day files are named by UTC date, so a day that starts after the cutoff has nothing earlier.
    if (Date.parse(`${day}T00:00:00Z`) > cutoff) continue;
    const loaded = await load(point, day);
    const before = loaded.issuances
      .filter((issuance) => Date.parse(issuance.fetched_utc) < cutoff)
      .sort((a, b) => Date.parse(b.fetched_utc) - Date.parse(a.fetched_utc));
    for (const issuance of before) {
      found.push(issuance);
      if (found.length === limit) return found;
    }
  }
  return found;
}
