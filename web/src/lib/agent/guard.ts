export type FinalAnswerArgs = {
  summary: string;
  cited_rule_ids: string[];
  window_indices: number[];
};

export type ToolResultRecord = {
  name: string;
  result: unknown;
};

export type GuardResult = {
  passed: boolean;
  reasons: string[];
};

const NUMBER_PATTERN = /-?\d+(?:[.,]\d+)*/g;

function numbersIn(value: string): Set<string> {
  return new Set(value.match(NUMBER_PATTERN) ?? []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Latin letters, ASCII digits, whitespace, ASCII punctuation, and the dashes, quotes and unit
// marks that show up in planner prose (including U+2011, which recorded answers already use).
// Han, Cyrillic and other scripts are outside this set on purpose.
function isAllowedAnswerChar(char: string): boolean {
  if (/[\p{Script=Latin}]/u.test(char)) return true;
  if (/\p{M}/u.test(char)) return true;
  if (/[0-9]/.test(char)) return true;
  if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\u00A0") return true;
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x21 && code <= 0x2f) return true;
  if (code >= 0x3a && code <= 0x40) return true;
  if (code >= 0x5b && code <= 0x60) return true;
  if (code >= 0x7b && code <= 0x7e) return true;
  if (code >= 0x2010 && code <= 0x2015) return true;
  if (code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d) return true;
  if (code === 0x2022 || code === 0x2026 || code === 0x2032 || code === 0x2033) return true;
  if (code === 0x00b0 || code === 0x00b1 || code === 0x00b7 || code === 0x00d7 || code === 0x00f7) return true;
  if (code === 0x2264 || code === 0x2265) return true;
  return false;
}

const NAMED_SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Han", /\p{Script=Han}/u],
  ["Hiragana", /\p{Script=Hiragana}/u],
  ["Katakana", /\p{Script=Katakana}/u],
  ["Hangul", /\p{Script=Hangul}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
];

function scriptNames(chars: readonly string[]): string {
  const names = NAMED_SCRIPTS
    .filter(([, pattern]) => chars.some((char) => pattern.test(char)))
    .map(([name]) => name);
  if (chars.some((char) => !NAMED_SCRIPTS.some(([, pattern]) => pattern.test(char)))) names.push("other");
  return names.join(", ");
}

function summaryEndsAsSentence(summary: string): boolean {
  return /[.!?]["'\u2019\u201D)\]\u00BB]*$/.test(summary.trim());
}

function scriptAndEndingReasons(answer: FinalAnswerArgs): string[] {
  const reasons: string[] = [];
  const prose = [answer.summary, ...answer.cited_rule_ids].join("\n");
  const outside: string[] = [];
  for (const char of prose) {
    if (!isAllowedAnswerChar(char)) outside.push(char);
  }
  if (outside.length > 0) {
    reasons.push(`The final answer contains characters outside Latin script (${scriptNames(outside)}).`);
  }
  if (!summaryEndsAsSentence(answer.summary)) {
    reasons.push("The summary does not end with sentence-final punctuation.");
  }
  return reasons;
}

// The guard checks what can be checked structurally: every cited rule id, every window index and
// every number in the summary must come from a tool result. The final answer must stay in Latin
// script, digits and ordinary punctuation, and the summary must end with sentence-final punctuation.
// It deliberately does NOT read window counts out of the prose. Two production false refusals
// (2026-10-05: "only the two windows ...", then "7 PM. Wed window" read as seven) and an adversarial
// review ("Only one available window starts at three PM; the other ...") showed that a count scoped
// by a predicate cannot be told apart from a total by pattern matching. The prompt tells the model
// not to state counts, and the page lists every returned window under the answer, so a wrong count
// would sit beside the true list.
export function guardFinalAnswer(
  answer: FinalAnswerArgs,
  toolResults: ToolResultRecord[],
): GuardResult {
  const reasons: string[] = [];
  const successfulResults = toolResults.filter((entry) => !(isRecord(entry.result) && typeof entry.result.error === "string"));
  const toolText = JSON.stringify(successfulResults.map((entry) => entry.result));

  for (const ruleId of answer.cited_rule_ids) {
    if (!toolText.includes(JSON.stringify(ruleId).slice(1, -1))) {
      reasons.push(`Rule ${ruleId} did not appear in a tool result.`);
    }
  }

  const latestCheck = [...successfulResults]
    .reverse()
    .find((entry) => entry.name === "check_tank")?.result;
  const windows = isRecord(latestCheck) && Array.isArray(latestCheck.windows)
    ? latestCheck.windows
    : [];
  const knownWindowIndices = new Set(
    windows
      .filter(isRecord)
      .map((window) => window.index)
      .filter((index): index is number => Number.isInteger(index)),
  );
  for (const index of answer.window_indices) {
    if (!knownWindowIndices.has(index)) {
      reasons.push(`Window ${index} did not appear in the latest check_tank result.`);
    }
  }

  const toolNumbers = numbersIn(toolText);
  for (const number of numbersIn(answer.summary)) {
    if (!toolNumbers.has(number)) {
      reasons.push(`Number ${number} did not appear in a tool result.`);
    }
  }

  reasons.push(...scriptAndEndingReasons(answer));

  return { passed: reasons.length === 0, reasons };
}
