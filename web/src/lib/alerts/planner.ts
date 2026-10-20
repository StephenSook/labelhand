import { readFile } from "node:fs/promises";
import path from "node:path";

import { evaluate, filterRules, initializeEngine, type CompiledLabel, type Rule } from "@/engine";
import type { AgentBindingClause, AgentCheckTankResult } from "@/lib/agent/tools";
import { getCachedLiveLabelStrict, getRegistrationCacheIndexStrict } from "@/lib/live-cache";
import { assertActiveRegistration, listLabelVersions } from "@/lib/ppls";
import { parseForecastPoints, parseLabelIndex, pointName, type ForecastPeriod, type PlannerHour } from "@/lib/planner-data";
import { forecastPermittedWindows, rankLimitingClauses, type ForecastWindow } from "@/lib/windows";

import type { AlertPlannerEvidence, AlertSubscription } from "./types";

const HORIZON_MS = 36 * 60 * 60 * 1_000;
const ENGINE_HOURS = 156;
const SHIPPED_REGISTRATIONS = new Set(["5481-504", "228-653", "228-659"]);
const projectRoot = process.cwd();

type TankProduct = { reg: string; name: string; rules: Rule[] };

async function readPublicJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(projectRoot, "public", "data", relative), "utf8")) as T;
}

let nodeEngine: Promise<void> | undefined;

async function initializeNodeEngine(): Promise<void> {
  nodeEngine ??= readFile(path.join(projectRoot, "src", "engine", "pkg", "labelhand_core_bg.wasm"))
    .then(async (wasm) => {
      await initializeEngine(new Uint8Array(wasm).buffer);
    });
  return nodeEngine;
}

type TankOptions = { pplsFetch?: typeof fetch };

async function compiledLabel(reg: string, options: TankOptions = {}): Promise<{ compiled: CompiledLabel; name: string }> {
  const labelIndex = parseLabelIndex(await readPublicJson<unknown>("labels/index.json"));
  if (SHIPPED_REGISTRATIONS.has(reg)) {
    const label = labelIndex[reg];
    if (!label) throw new Error(`The shipped label index is missing EPA Reg. ${reg}.`);
    return {
      compiled: await readPublicJson<CompiledLabel>(`compiled/${reg}.ship.json`),
      name: label.shortName,
    };
  }

  // A live label is rechecked with EPA before every run, as the compile route does, so a call never names a
  // product whose registration EPA has since cancelled. If EPA does not answer, this run fails and no call goes out.
  assertActiveRegistration(await listLabelVersions(reg, options.pplsFetch));
  const index = await getRegistrationCacheIndexStrict(reg);
  if (!index) throw new RangeError(`EPA Reg. ${reg} has not been compiled into the live cache.`);
  const cached = await getCachedLiveLabelStrict(index.sha256, index.pipelineVersion);
  if (!cached || cached.reg !== reg) throw new RangeError(`EPA Reg. ${reg} has no complete live compile.`);
  return { compiled: cached, name: cached.product };
}

export async function loadAlertTank(registrations: string[], options: TankOptions = {}): Promise<TankProduct[]> {
  await initializeNodeEngine();
  return Promise.all(registrations.map(async (reg) => {
    const label = await compiledLabel(reg, options);
    const filtered = await filterRules(label.compiled, reg);
    return { reg, name: label.name, rules: filtered.used };
  }));
}

export async function alertFieldNames(): Promise<Map<string, string>> {
  const points = parseForecastPoints(await readPublicJson<unknown>("nws_points_cache.json"));
  return new Map(Object.entries(points).map(([key, point]) => [key, pointName(key, point)]));
}

function easternDay(value: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const hourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
});

function matchingHourLabel(hours: PlannerHour[], ruleId: string): string {
  const matched = hours.find((hour) => [...hour.blocked, ...hour.checks].some((citation) => citation.rule === ruleId));
  return matched ? hourFormatter.format(new Date(matched.start)) : "remaining forecast";
}

function agentEvidence(
  subscription: AlertSubscription,
  fieldName: string,
  products: TankProduct[],
  hours: PlannerHour[],
  window: ForecastWindow,
  fetchedAt: string,
): AgentCheckTankResult {
  const windowDay = easternDay(window.start);
  const remaining = hours.filter((hour) => Date.parse(hour.start) >= Date.parse(window.start) && easternDay(hour.start) === windowDay);
  const counts = remaining.reduce((current, hour) => {
    if (hour.state === "PERMITTED") current.FORECAST_PERMITTED += 1;
    else current[hour.state] += 1;
    return current;
  }, { FORECAST_PERMITTED: 0, FIELD_CHECK: 0, BLOCKED: 0 });
  const bindingClauses: AgentBindingClause[] = rankLimitingClauses(remaining).slice(0, 12).map((clause) => ({
    rule_id: clause.rule,
    product: clause.product,
    page: clause.page,
    quote: clause.quote.slice(0, 160),
    why: clause.why,
    hour_label: matchingHourLabel(remaining, clause.rule),
  }));
  return {
    field: fieldName,
    products: products.map((product) => product.reg),
    job_hours: subscription.jobHours,
    source: { kind: "LIVE", time: fetchedAt },
    counts,
    windows: [{ index: 0, label: `${hourFormatter.format(new Date(window.start))} to ${hourFormatter.format(new Date(window.end))} (${window.length} h)`, start: window.start, end: window.end, hours: window.length }],
    binding_clauses: bindingClauses,
  };
}

function fallbackWhy(check: AgentCheckTankResult): string {
  const clauses = check.binding_clauses.slice(0, 3);
  if (clauses.length === 0) {
    return "The planner found no label clause limiting the remaining hours in this forecast. Field checks required by the label remain your responsibility.";
  }
  const details = clauses.map((clause) => `${clause.product}, clause ${clause.rule_id}: ${clause.why}`).join(". ");
  return `The planner found these limits outside the called window. ${details}. Field checks required by the label remain your responsibility.`;
}

export async function planAlert(
  subscription: AlertSubscription,
  input: { now: Date; fetchImpl?: typeof fetch },
): Promise<AlertPlannerEvidence | null> {
  const points = parseForecastPoints(await readPublicJson<unknown>("nws_points_cache.json"));
  const point = points[subscription.field];
  if (!point) throw new RangeError(`No forecast point named ${subscription.field} exists.`);
  const products = await loadAlertTank(subscription.tankRegs);
  const response = await (input.fetchImpl ?? fetch)(point.forecastHourly, { cache: "no-store" });
  if (!response.ok) throw new Error(`The NWS hourly forecast returned HTTP ${response.status}.`);
  const payload = await response.json() as { properties?: { periods?: ForecastPeriod[] } };
  const periods = payload.properties?.periods;
  if (!Array.isArray(periods) || periods.length === 0) throw new Error("The NWS hourly forecast returned no periods.");
  const rules = products.flatMap((product) => product.rules);
  const hours = await evaluate(rules, periods, point.lat, point.lon, ENGINE_HOURS) as PlannerHour[];
  const latestStart = input.now.getTime() + HORIZON_MS;
  const futureHours = hours.filter((hour) => Date.parse(hour.start) >= input.now.getTime());
  const window = forecastPermittedWindows(futureHours, subscription.jobHours).find((candidate) => {
    const start = Date.parse(candidate.start);
    return start <= latestStart;
  });
  if (!window) return null;

  const fetchedAt = input.now.toISOString();
  const fieldName = pointName(subscription.field, point);
  const check = agentEvidence(subscription, fieldName, products, hours, window, fetchedAt);
  return {
    fieldKey: subscription.field,
    fieldName,
    products: products.map((product) => ({ reg: product.reg, name: product.name })),
    source: "LIVE",
    fetchedAt,
    jobHours: subscription.jobHours,
    calledWindow: { start: window.start, end: window.end, hours: window.length },
    agentCheck: check,
    fallbackSummary: fallbackWhy(check),
  };
}
