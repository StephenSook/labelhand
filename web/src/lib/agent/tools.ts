import type { FilterRulesResult, Rule } from "@/engine";
import type { LabelIndex, PlannerHour } from "@/lib/planner-data";
import type { ForecastWindow } from "@/lib/windows";
import type { FinalAnswerArgs } from "./guard";

// The ten NWS forecast points the recorder and the planner know (data/nws_points_cache.json). Listing them in the
// schema lets the first step force check_tank by name: with two tools and tool_choice "required", Nemotron 3.5
// Lightning emitted a correct call and then kept generating until max_tokens (finish_reason "length", 700 tokens).
export const FIELD_KEYS = ["tift", "worth", "ben_hill", "colquitt", "mitchell", "dooly", "coffee", "irwin", "berrien", "cook"] as const;

export const AGENT_TOOL_NAMES = [
  "check_tank",
  "get_clause",
  "final_answer",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const AGENT_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "check_tank",
      description: "Fetch the field forecast and run the real deterministic tank planner for 156 hours.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["field", "products", "job_hours"],
        properties: {
          field: { type: "string", enum: [...FIELD_KEYS], description: "The Georgia forecast point (county), e.g. tift or worth. Use tift if the question names none." },
          products: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", enum: ["5481-504", "264-700", "264-418"] },
          },
          job_hours: { type: "integer", minimum: 1, maximum: 12 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_clause",
      description: "Return one full EPA label rule after check_tank has exposed its rule ID.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["rule_id"],
        properties: { rule_id: { type: "string", minLength: 1 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "final_answer",
      description: "Finish with a grounded answer. Call this only after the needed planner tools.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "cited_rule_ids", "window_indices"],
        properties: {
          summary: { type: "string", maxLength: 400 },
          cited_rule_ids: { type: "array", uniqueItems: true, items: { type: "string" } },
          window_indices: { type: "array", uniqueItems: true, items: { type: "integer", minimum: 0 } },
        },
      },
    },
  },
] as const;

type SourceKind = "LIVE" | "RECORDED";

export type AgentBindingClause = {
  rule_id: string;
  product: string;
  page: unknown;
  quote: string;
  why: string;
  hour_label: string;
};

export type AgentCheckTankResult = {
  field: string;
  products: string[];
  job_hours: number;
  source: { kind: SourceKind; time: string };
  counts: { FORECAST_PERMITTED: number; FIELD_CHECK: number; BLOCKED: number };
  windows: Array<{ index: number; label: string; start: string; end: string; hours: number }>;
  binding_clauses: AgentBindingClause[];
};

export type AgentCheckSnapshot = {
  pointKey: string;
  source: SourceKind;
  fetchedAt: string;
  jobHours: number;
  products: string[];
  hours: PlannerHour[];
  ruleGroups: FilterRulesResult[];
  windows: ForecastWindow[];
};

export type AgentToolRuntime = {
  latestCheck?: AgentCheckSnapshot;
  labels?: LabelIndex;
  rulesById: Map<string, Rule>;
};

export function createAgentToolRuntime(): AgentToolRuntime {
  return { rulesById: new Map() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, tool: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${tool} arguments must be an object.`);
  return value;
}

function titleCaseField(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

const hourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
});

function hourLabel(value: string): string {
  return hourFormatter.format(new Date(value));
}

function windowLabel(window: ForecastWindow): string {
  return `${hourLabel(window.start)} to ${hourLabel(window.end)} (${window.length} h)`;
}

function resultSummary(name: AgentToolName, result: unknown): string {
  if (name === "check_tank" && isRecord(result) && isRecord(result.source) && Array.isArray(result.windows)) {
    return `${String(result.source.kind)} forecast checked; ${result.windows.length} permitted windows returned`;
  }
  if (name === "get_clause" && isRecord(result)) return `Clause ${String(result.rule_id)} returned`;
  return "Final answer received";
}

export async function executeAgentTool(
  name: AgentToolName,
  args: unknown,
  runtime: AgentToolRuntime,
): Promise<{ result: unknown; summary: string }> {
  let result: unknown;
  if (name === "check_tank") result = await checkTank(args, runtime);
  else if (name === "get_clause") result = getClause(args, runtime);
  else result = parseFinalAnswer(args);
  return { result, summary: resultSummary(name, result) };
}

async function checkTank(args: unknown, runtime: AgentToolRuntime): Promise<AgentCheckTankResult> {
  const input = requireRecord(args, "check_tank");
  const field = typeof input.field === "string" ? input.field : "";
  const products = Array.isArray(input.products) ? input.products : [];
  const jobHours = input.job_hours;
  const allowed = new Set(["5481-504", "264-700", "264-418"]);
  if (!field) throw new TypeError("check_tank field must be a non-empty string.");
  if (products.length < 1 || products.length > 3 || products.some((reg) => typeof reg !== "string" || !allowed.has(reg))) {
    throw new TypeError("check_tank products must contain one to three supported registration numbers.");
  }
  if (!Number.isInteger(jobHours) || (jobHours as number) < 1 || (jobHours as number) > 12) {
    throw new TypeError("check_tank job_hours must be an integer from 1 through 12.");
  }

  const engine = await import("@/engine");
  const planner = await import("@/lib/planner-data");
  const { forecastPermittedWindows } = await import("@/lib/windows");
  const [pointsPayload, labelsPayload] = await Promise.all([
    planner.fetchJson<unknown>("/data/nws_points_cache.json"),
    planner.fetchJson<unknown>("/data/labels/index.json"),
  ]);
  const points = planner.parseForecastPoints(pointsPayload);
  const labels = planner.parseLabelIndex(labelsPayload);
  const point = points[field];
  if (!point) throw new RangeError(`No forecast point named ${field} exists.`);

  let source: SourceKind = "LIVE";
  let periods: import("@/engine").ForecastPeriod[];
  let fetchedAt: string;
  try {
    const live = await planner.fetchLivePeriods(point.forecastHourly);
    periods = live.periods;
    fetchedAt = live.fetchedAt;
  } catch (liveError) {
    if (!planner.REPLAY_POINTS.has(field)) {
      throw new Error(`Live forecast failed: ${planner.errorText(liveError)} No recorded fallback is available for ${field}.`);
    }
    const replay = await planner.fetchReplay(field);
    source = "RECORDED";
    periods = replay.periods;
    fetchedAt = replay.forecast_fetched_utc;
  }

  const ruleGroups = await Promise.all(products.map(async (reg) => {
    const compiled = await planner.fetchJson<import("@/engine").CompiledLabel>(`/data/compiled/${reg}.union.typed.v3.json`);
    return engine.filterRules(compiled, reg);
  }));
  runtime.rulesById.clear();
  for (const group of ruleGroups) {
    for (const rule of group.used) runtime.rulesById.set(rule.id, rule);
  }
  const rules = ruleGroups.flatMap((group) => group.used);
  const hours = await engine.evaluate(rules, periods, point.lat, point.lon, 156) as PlannerHour[];
  const windows = forecastPermittedWindows(hours, jobHours as number);
  const counts = hours.reduce((current, hour) => {
    if (hour.state === "PERMITTED") current.FORECAST_PERMITTED += 1;
    else current[hour.state] += 1;
    return current;
  }, { FORECAST_PERMITTED: 0, FIELD_CHECK: 0, BLOCKED: 0 });

  const bindingClauses: AgentBindingClause[] = [];
  const seenRules = new Set<string>();
  for (const hour of hours) {
    if (hour.state === "PERMITTED") continue;
    for (const citation of [...hour.blocked, ...hour.checks]) {
      if (seenRules.has(citation.rule)) continue;
      seenRules.add(citation.rule);
      bindingClauses.push({
        rule_id: citation.rule,
        product: citation.product,
        page: citation.page,
        quote: citation.quote.slice(0, 160),
        why: citation.why,
        hour_label: hourLabel(hour.start),
      });
      if (bindingClauses.length === 12) break;
    }
    if (bindingClauses.length === 12) break;
  }

  runtime.labels = labels;
  runtime.latestCheck = {
    pointKey: field,
    source,
    fetchedAt,
    jobHours: jobHours as number,
    products: products as string[],
    hours,
    ruleGroups,
    windows,
  };

  return {
    field: titleCaseField(field),
    products: products as string[],
    job_hours: jobHours as number,
    source: { kind: source, time: fetchedAt },
    counts,
    windows: windows.map((window, index) => ({
      index,
      label: windowLabel(window),
      start: window.start,
      end: window.end,
      hours: window.length,
    })),
    binding_clauses: bindingClauses,
  };
}

function getClause(args: unknown, runtime: AgentToolRuntime) {
  const input = requireRecord(args, "get_clause");
  const ruleId = typeof input.rule_id === "string" ? input.rule_id : "";
  const rule = runtime.rulesById.get(ruleId);
  if (!rule) throw new RangeError(`Rule ${ruleId || "(missing)"} was not returned by this conversation's check_tank call.`);
  const registration = typeof rule.reg === "string" ? rule.reg : undefined;
  const label = registration ? runtime.labels?.[registration] : undefined;
  const page = rule.page;
  return {
    rule_id: rule.id,
    product: rule.product ?? label?.product ?? "Unknown product",
    page,
    param: rule.param,
    modality: rule.modality,
    quote: rule.quote,
    epa_url_with_page: label ? `${label.url}#page=${encodeURIComponent(String(page))}` : null,
  };
}

function parseFinalAnswer(args: unknown): FinalAnswerArgs {
  const input = requireRecord(args, "final_answer");
  if (typeof input.summary !== "string" || input.summary.length > 400) {
    throw new TypeError("final_answer summary must be a string no longer than 400 characters.");
  }
  if (!Array.isArray(input.cited_rule_ids) || input.cited_rule_ids.some((value) => typeof value !== "string")) {
    throw new TypeError("final_answer cited_rule_ids must be an array of strings.");
  }
  if (!Array.isArray(input.window_indices) || input.window_indices.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError("final_answer window_indices must be an array of non-negative integers.");
  }
  return {
    summary: input.summary,
    cited_rule_ids: input.cited_rule_ids as string[],
    window_indices: input.window_indices as number[],
  };
}
