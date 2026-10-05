import { evaluate, filterRules, type CompiledLabel } from "@/engine";
import {
  REPLAY_POINTS,
  errorText,
  fetchJson,
  fetchLivePeriods,
  fetchReplay,
  type FilteredRules,
  type ForecastPeriod,
  type ForecastPoints,
  type PlannerHour,
  type ProductRegistration,
  type ReplayForecast,
} from "@/lib/planner-data";

export type PlannerSource = "LIVE" | "RECORDED";

export type PlannerCheckResult = {
  pointKey: string;
  source: PlannerSource;
  fetchedAt: string;
  periods: ForecastPeriod[];
  lat: number;
  lon: number;
  hours: PlannerHour[];
  ruleGroups: FilteredRules[];
  registrations: ProductRegistration[];
  liveFailure?: string;
};

type PlannerCheckInput = {
  pointKey: string;
  registrations: ProductRegistration[];
  points: ForecastPoints;
  source: PlannerSource;
  suppliedReplay?: ReplayForecast;
  fallbackToReplay?: boolean;
  onProgress?: (completedStep: 1 | 2 | 3, durationMs: number) => void;
};

export async function runPlannerCheck({
  pointKey,
  registrations,
  points,
  source,
  suppliedReplay,
  fallbackToReplay = false,
  onProgress,
}: PlannerCheckInput): Promise<PlannerCheckResult> {
  const point = points[pointKey];
  if (!point) {
    throw new Error(`No forecast point named ${pointKey} was found in /data/nws_points_cache.json`);
  }
  if (registrations.length === 0) {
    throw new Error("Choose at least one product in the tank.");
  }

  const forecastStart = performance.now();
  let periods: ForecastPeriod[];
  let fetchedAt: string;
  let resolvedSource = source;
  let liveFailure: string | undefined;
  if (source === "RECORDED") {
    const replay = suppliedReplay ?? await fetchReplay(pointKey);
    periods = replay.periods;
    fetchedAt = replay.forecast_fetched_utc;
  } else {
    try {
      const live = await fetchLivePeriods(point.forecastHourly);
      periods = live.periods;
      fetchedAt = live.fetchedAt;
    } catch (error) {
      if (!fallbackToReplay || !REPLAY_POINTS.has(pointKey)) throw error;
      const replay = await fetchReplay(pointKey);
      periods = replay.periods;
      fetchedAt = replay.forecast_fetched_utc;
      resolvedSource = "RECORDED";
      liveFailure = errorText(error);
    }
  }
  onProgress?.(1, performance.now() - forecastStart);

  const rulesStart = performance.now();
  const ruleGroups = await Promise.all(registrations.map(async (reg) => {
    const compiled = await fetchJson<CompiledLabel>(`/data/compiled/${reg}.ship.json`);
    return await filterRules(compiled, reg);
  }));
  const usedRules = ruleGroups.flatMap((group) => group.used);
  onProgress?.(2, performance.now() - rulesStart);

  const plannerStart = performance.now();
  const evaluated = await evaluate(usedRules, periods, point.lat, point.lon, 156) as PlannerHour[];
  onProgress?.(3, performance.now() - plannerStart);
  if (evaluated.length !== Math.min(156, periods.length)) {
    throw new Error(`The planner returned ${evaluated.length} hours for ${periods.length} forecast periods`);
  }

  return {
    pointKey,
    source: resolvedSource,
    fetchedAt,
    periods,
    lat: point.lat,
    lon: point.lon,
    hours: evaluated,
    ruleGroups,
    registrations,
    liveFailure,
  };
}
