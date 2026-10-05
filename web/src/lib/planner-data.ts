export const PRODUCT_REGISTRATIONS = ["5481-504", "264-700", "264-418"] as const;

export type ProductRegistration = (typeof PRODUCT_REGISTRATIONS)[number];

export type PlannerState = "PERMITTED" | "BLOCKED" | "FIELD_CHECK";

export type ForecastPoint = {
  name: string;
  lat: number;
  lon: number;
  forecastHourly: string;
};

export type ForecastPoints = Record<string, ForecastPoint>;

export type LabelRecord = {
  reg: string;
  product: string;
  shortName: string;
  accepted: string;
  url: string;
  bytes: number;
  sha256: string;
};

export type LabelIndex = Record<string, LabelRecord>;

export type PlannerRule = EngineRule;

export type SkippedRule = {
  id: string;
  param: string;
  why: string;
};

export type FilteredRules = FilterRulesResult;

export type Citation = EngineCitation;

export type PlannerHour = EvaluatedHour;

export type ForecastPeriod = EngineForecastPeriod;

export type ReplayForecast = {
  forecast_fetched_utc: string;
  periods: ForecastPeriod[];
};

export const REPLAY_POINTS = new Set(["tift", "worth", "colquitt"]);

export function pointName(key: string, point: Partial<ForecastPoint>): string {
  const source = typeof point.name === "string" && point.name.trim() ? point.name : key;
  return source
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function orderedPointEntries(points: ForecastPoints): Array<[string, ForecastPoint]> {
  const priority = new Map([
    ["tift", 0],
    ["worth", 1],
    ["colquitt", 2],
  ]);
  return Object.entries(points).sort(([a], [b]) => {
    const aRank = priority.get(a) ?? 100;
    const bRank = priority.get(b) ?? 100;
    return aRank - bRank || pointName(a, points[a]).localeCompare(pointName(b, points[b]));
  });
}

export function displayState(state: PlannerState): "FORECAST-PERMITTED" | "FIELD CHECK" | "BLOCKED" {
  if (state === "PERMITTED") return "FORECAST-PERMITTED";
  if (state === "FIELD_CHECK") return "FIELD CHECK";
  return "BLOCKED";
}

export function parseForecastPoints(value: unknown): ForecastPoints {
  const entries = Array.isArray(value)
    ? value.map((point) => [isRecord(point) ? point.name : undefined, point] as const)
    : isRecord(value) ? Object.entries(value) : [];
  const points: ForecastPoints = {};
  for (const [candidateKey, candidate] of entries) {
    if (!isRecord(candidate)) continue;
    const key = typeof candidate.name === "string" ? candidate.name : candidateKey;
    if (
      typeof key === "string" &&
      typeof candidate.lat === "number" &&
      typeof candidate.lon === "number" &&
      typeof candidate.forecastHourly === "string"
    ) {
      points[key] = { name: key, lat: candidate.lat, lon: candidate.lon, forecastHourly: candidate.forecastHourly };
    }
  }
  if (Object.keys(points).length === 0) {
    throw new Error("/data/nws_points_cache.json contained no usable forecast points");
  }
  return points;
}

export function parseLabelIndex(value: unknown): LabelIndex {
  const entries = Array.isArray(value)
    ? value.map((label) => [isRecord(label) ? label.reg : undefined, label] as const)
    : isRecord(value) ? Object.entries(value) : [];
  const labels: LabelIndex = {};
  for (const [candidateKey, candidate] of entries) {
    if (!isRecord(candidate)) continue;
    const reg = typeof candidate.reg === "string" ? candidate.reg : candidateKey;
    if (
      typeof reg === "string" &&
      typeof candidate.product === "string" &&
      typeof candidate.shortName === "string" &&
      typeof candidate.accepted === "string" &&
      typeof candidate.url === "string" &&
      typeof candidate.bytes === "number" &&
      typeof candidate.sha256 === "string"
    ) {
      labels[reg] = {
        reg,
        product: candidate.product,
        shortName: candidate.shortName,
        accepted: candidate.accepted,
        url: candidate.url,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
      };
    }
  }
  if (Object.keys(labels).length === 0) {
    throw new Error("/data/labels/index.json contained no usable EPA label records");
  }
  return labels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stateIcon(state: PlannerState): string {
  if (state === "PERMITTED") return "✓";
  if (state === "FIELD_CHECK") return "☀";
  return "×";
}

export function formatForecastTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as T;
}

export async function fetchLivePeriods(url: string): Promise<{
  periods: ForecastPeriod[];
  fetchedAt: string;
}> {
  const payload = await fetchJson<{ properties?: { periods?: ForecastPeriod[] } }>(url);
  const periods = payload.properties?.periods;
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error(`${url} returned no properties.periods forecast array`);
  }
  return { periods, fetchedAt: new Date().toISOString() };
}

export async function fetchReplay(point: string): Promise<ReplayForecast> {
  const replay = await fetchJson<Partial<ReplayForecast>>(`/data/replay/${point}.json`);
  if (!Array.isArray(replay.periods) || replay.periods.length === 0) {
    throw new Error(`/data/replay/${point}.json returned no periods forecast array`);
  }
  if (typeof replay.forecast_fetched_utc !== "string" || !replay.forecast_fetched_utc) {
    throw new Error(`/data/replay/${point}.json returned no forecast_fetched_utc`);
  }
  return replay as ReplayForecast;
}
import type {
  Citation as EngineCitation,
  EvaluatedHour,
  FilterRulesResult,
  ForecastPeriod as EngineForecastPeriod,
  Rule as EngineRule,
} from "@/engine";
