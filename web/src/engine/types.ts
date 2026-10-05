export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Rule {
  id: string;
  page: JsonValue;
  product?: string;
  reg?: string;
  param: string;
  op: string;
  value?: JsonValue;
  value2?: JsonValue;
  unit: string | null;
  modality: string;
  quote: string;
  [key: string]: unknown;
}

export interface CompiledLabel {
  product: string;
  accepted: Rule[];
  [key: string]: unknown;
}

export interface SkippedRule {
  id: string;
  param: string;
  why: string;
}

export interface FilterRulesResult {
  product: string;
  used: Rule[];
  skipped: SkippedRule[];
}

export interface ProbabilityOfPrecipitation {
  value?: JsonValue;
  [key: string]: unknown;
}

export interface ForecastPeriod {
  startTime: string;
  isDaytime?: boolean;
  temperature?: JsonValue;
  windSpeed?: string;
  probabilityOfPrecipitation?: ProbabilityOfPrecipitation;
  [key: string]: unknown;
}

export interface Citation {
  product: string;
  rule: string;
  page: JsonValue;
  quote: string;
  why: string;
}

export type EvaluationState = "PERMITTED" | "BLOCKED" | "FIELD_CHECK";

export interface EvaluatedHour {
  start: string;
  state: EvaluationState;
  temp_f: JsonValue;
  wind: string | null;
  pop: JsonValue;
  sun_alt: number;
  blocked: Citation[];
  checks: Citation[];
  advisories: Citation[];
}
