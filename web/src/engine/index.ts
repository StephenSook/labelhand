import type { InitInput } from "./pkg/labelhand_core.js";
import type {
  CompiledLabel,
  EvaluatedHour,
  FilterRulesResult,
  ForecastPeriod,
  Rule,
} from "./types";

type EngineModule = typeof import("./pkg/labelhand_core.js");

let enginePromise: Promise<EngineModule> | undefined;

export function initializeEngine(input?: InitInput): Promise<EngineModule> {
  if (!enginePromise) {
    enginePromise = import("./pkg/labelhand_core.js").then(async (engine) => {
      if (input === undefined) {
        await engine.default();
      } else {
        await engine.default({ module_or_path: input });
      }
      return engine;
    });
  }
  return enginePromise;
}

export async function filterRules(
  compiled: CompiledLabel,
  reg: string,
): Promise<FilterRulesResult> {
  const engine = await initializeEngine();
  return JSON.parse(engine.filter_rules_json(JSON.stringify(compiled), reg)) as FilterRulesResult;
}

export async function evaluate(
  rules: Rule[],
  periods: ForecastPeriod[],
  lat: number,
  lon: number,
  hours: number,
): Promise<EvaluatedHour[]> {
  const engine = await initializeEngine();
  const result = JSON.parse(
    engine.evaluate_json(JSON.stringify(rules), JSON.stringify(periods), lat, lon, hours),
  ) as unknown;
  if (!Array.isArray(result)) {
    throw new TypeError("The planner returned a non-array result.");
  }
  return result as EvaluatedHour[];
}

export type {
  Citation,
  CompiledLabel,
  EvaluatedHour,
  EvaluationState,
  FilterRulesResult,
  ForecastPeriod,
  JsonPrimitive,
  JsonValue,
  ProbabilityOfPrecipitation,
  Rule,
  SkippedRule,
} from "./types";
