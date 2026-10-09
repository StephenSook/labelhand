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

// Modifiers that can sit between an exclusivity determiner and the noun "window".
// Arbitrary words are not allowed: "the only product in window 0" is not a one-window claim.
const WINDOW_MODIFIER = "forecast-permitted|forecast|permitted|listed|returned|available|open|remaining|usable";

function headedWindow(prefix: string, noun: "window" | "windows?"): RegExp {
  return new RegExp(`\\b${prefix}(?:\\s+(?:${WINDOW_MODIFIER})){0,4}\\s+${noun}\\b`, "i");
}

const THE_ONLY_WINDOW = headedWindow("the only", "window");
const SOLE_OR_SINGLE_WINDOW = headedWindow("(?:sole|single)", "window");
const JUST_ONE_WINDOW = headedWindow("just one", "window");
const ONLY_ONE_WINDOW = headedWindow("only one", "window");
const NO_OTHER_WINDOW = headedWindow("no other", "windows?");
const ALL_OTHER_WINDOWS = headedWindow("all other", "windows?");
const BLOCK_CLAIM = /\b(?:would block|will block|blocks|(?:are|is|were|was)\s+blocked|not permitted|aren't permitted|isn't permitted)\b/i;
const THE_REST_DENIED = /\bthe rest\b(?:\s+\S+){0,6}?\s+(?:are|were)\s+(?:blocked|not permitted)\b/i;
const OTHER_IS_BLOCKED = /\b(?:the other|another)\b(?:\s+\S+){0,8}?\s+(?:is|are|was|were)\s+blocked\b/i;
const OTHER_NOT_PERMITTED = /\b(?:the other|another)\b(?:\s+\S+){0,12}?\b(?:would block|not permitted|aren't permitted|isn't permitted)\b/i;

function sentencesOf(summary: string): string[] {
  return summary.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

// "Only one available window starts at three PM; the other starts at seven PM" names one window
// and then another. That is not a claim that a single window was returned. The same shape with
// "the other is blocked" stays a claim.
function acknowledgesAnotherOpenWindow(summary: string): boolean {
  if (!/\b(?:the other|another)\b/i.test(summary)) return false;
  if (OTHER_IS_BLOCKED.test(summary) || OTHER_NOT_PERMITTED.test(summary)) return false;
  return true;
}

function claimsOthersAreBlocked(summary: string): boolean {
  if (THE_REST_DENIED.test(summary)) return true;
  return sentencesOf(summary).some((sentence) => ALL_OTHER_WINDOWS.test(sentence) && BLOCK_CLAIM.test(sentence));
}

function exclusivityReasons(summary: string, permittedCount: number): string[] {
  if (permittedCount <= 1) return [];
  const anotherOpen = acknowledgesAnotherOpenWindow(summary);
  const claimsOneWindow = THE_ONLY_WINDOW.test(summary)
    || SOLE_OR_SINGLE_WINDOW.test(summary)
    || NO_OTHER_WINDOW.test(summary)
    || (!anotherOpen && (ONLY_ONE_WINDOW.test(summary) || JUST_ONE_WINDOW.test(summary)));
  if (!claimsOneWindow && !claimsOthersAreBlocked(summary)) return [];
  return [
    `The summary claims a single permitted window, or that the other windows are blocked, but check_tank returned ${permittedCount} permitted windows.`,
  ];
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
// Exclusivity compares a fixed set of phrases with the structured window list. It does not read a
// window count out of prose. Two production false refusals (2026-10-05: "only the two windows ...",
// then "7 PM. Wed window" read as seven) and an adversarial review ("Only one available window
// starts at three PM; the other ...") showed that a count scoped by a predicate cannot be told apart
// from a total by pattern matching. Those sentences stay allowed. "the only window", "a single
// window", and "all other windows are blocked" are rejected only when the list has more than one
// permitted window. The prompt tells the model not to state counts, and the page lists every
// returned window under the answer.
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
  const windowRecords = windows.filter(isRecord);
  const knownWindowIndices = new Set(
    windowRecords
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
  reasons.push(...exclusivityReasons(answer.summary, windowRecords.length));

  return { passed: reasons.length === 0, reasons };
}
