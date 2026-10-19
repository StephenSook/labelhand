import { guard, norm, restoreUnits, type GuardRule } from "./guards";
import spec from "./spec.generated.json";
import {
  callStrictJson,
  throwIfTokenFactoryAborted,
  type StrictJsonResult,
  type TokenFactoryOptions,
  type TokenUsage,
} from "./token-factory";

export const TYPING_MODEL = spec.MODELS.typing;
export const TOPIC_WORDS = spec.TOPIC_WORDS;
const ACTING = new Set(["MUST", "MUST_NOT"]);

export interface TypedAnswer extends GuardRule {
  param: string;
  op: string;
  modality: string;
  unit: string | null;
  value: number | null;
  value2: number | null;
}

export interface CompilerRule extends TypedAnswer {
  id: string;
  page: number;
  quote: string;
  summary?: string;
  [key: string]: unknown;
}

export interface VoteInfo {
  votes: Array<{ param: string; modality: string }>;
  unanimous: boolean;
}

export type TypingCallResult =
  | {
      ok: true;
      typed: TypedAnswer;
      usage: TokenUsage;
      requestId: string | null;
    }
  | {
      ok: false;
      error: string;
      status?: number;
    };

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function mostCommon(values: string[]): string {
  return unique(values).reduce((best, value) => (
    values.filter((candidate) => candidate === value).length > values.filter((candidate) => candidate === best).length
      ? value
      : best
  ));
}

export function vote(firstPassParam: string, typed: TypedAnswer[]): { chosen: TypedAnswer; info: VoteInfo } {
  if (typed.length === 0) throw new TypeError("Typing vote requires at least one answer.");
  const params = typed.map(({ param }) => param);
  const top = Math.max(...unique(params).map((param) => params.filter((candidate) => candidate === param).length));
  const tied = unique(params).filter((param) => params.filter((candidate) => candidate === param).length === top);
  const param = tied.includes(firstPassParam) ? firstPassParam : tied[0];
  const same = typed.filter((answer) => answer.param === param);
  const modalities = same.map(({ modality }) => modality);
  const acting = modalities.filter((modality) => ACTING.has(modality));
  const modality = mostCommon(acting.length > 0 ? acting : modalities);
  const chosen = same.find((answer) => answer.modality === modality);
  if (!chosen) throw new TypeError("Typing vote could not select an answer.");
  return {
    chosen,
    info: {
      votes: typed.map(({ param: answerParam, modality: answerModality }) => ({
        param: answerParam,
        modality: answerModality,
      })),
      unanimous: new Set(typed.map(({ param: answerParam, modality: answerModality }) => `${answerParam}\u0000${answerModality}`)).size === 1,
    },
  };
}

export function hasTopicWord(rule: Pick<CompilerRule, "quote">): boolean {
  const quote = rule.quote.toLowerCase();
  return TOPIC_WORDS.some((word) => quote.includes(word));
}

export async function typeRule(rule: CompilerRule, options: TokenFactoryOptions): Promise<TypingCallResult> {
  try {
    const result: StrictJsonResult<TypedAnswer> = await callStrictJson<TypedAnswer>(
      {
        model: TYPING_MODEL,
        system: spec.PROMPTS.typing,
        user: `CLAUSE: ${rule.quote}\nCONSTRAINT TO TYPE: ${rule.summary || "the main constraint of the clause"}`,
        schemaName: "typed_rule",
        schema: spec.SCHEMAS.typing,
        maxTokens: 400,
      },
      options,
    );
    return { ok: true, typed: result.value, usage: result.usage, requestId: result.requestId };
  } catch (error) {
    throwIfTokenFactoryAborted(options.signal);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Token Factory typing failed.",
      ...(typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? { status: error.status }
        : {}),
    };
  }
}

export function applyTyping(rule: CompilerRule, typed: TypedAnswer): CompilerRule {
  const { chosen } = vote(rule.param, [typed]);
  const candidate = restoreUnits({
    ...rule,
    ...chosen,
    first_pass_param: rule.param,
    typed_by: TYPING_MODEL,
    agreed: chosen.param === rule.param,
  });
  const reason = guard(candidate, norm(rule.quote));
  if (reason) {
    return {
      ...rule,
      first_pass_param: rule.param,
      typed_by: TYPING_MODEL,
      agreed: null,
      retype_rejected: reason,
    };
  }
  return candidate;
}

export function keepFirstPass(rule: CompilerRule): CompilerRule {
  return {
    ...rule,
    first_pass_param: rule.param,
    typed_by: null,
    agreed: null,
  };
}
