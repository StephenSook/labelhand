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

const COUNT_WORDS: Record<string, number> = {
  no: 0, zero: 0, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// A count of windows stated in the summary ("two 4-hour windows", "the only window", "3 windows").
// Up to two words may sit between the count and "window" ("two 4-hour permitted windows"). The word
// "only" alone is not a count: "only the two windows fit" is a true claim about two windows. "One of
// the windows" names a member, not a count, so a count followed by "of" is skipped.
const COUNTED_WINDOWS = /\b(no|zero|one|single|two|three|four|five|six|seven|eight|nine|ten|\d+)(?!\s+of\b)\s+(?:\S+\s+){0,2}?windows?\b/giu;
const THE_ONLY_WINDOW = /\b(?:the\s+)?only\s+(?:\S+\s+){0,2}?window\b/giu;

function claimedWindowCounts(summary: string): number[] {
  const counts: number[] = [];
  for (const match of summary.matchAll(COUNTED_WINDOWS)) {
    const word = match[1].toLowerCase();
    counts.push(word in COUNT_WORDS ? COUNT_WORDS[word] : Number(word));
  }
  for (const _ of summary.matchAll(THE_ONLY_WINDOW)) counts.push(1);
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  for (const claimed of claimedWindowCounts(answer.summary)) {
    if (claimed !== knownWindowIndices.size) {
      reasons.push(`The summary claims ${claimed} window${claimed === 1 ? "" : "s"}, but check_tank returned ${knownWindowIndices.size}.`);
    }
  }

  const toolNumbers = numbersIn(toolText);
  for (const number of numbersIn(answer.summary)) {
    if (!toolNumbers.has(number)) {
      reasons.push(`Number ${number} did not appear in a tool result.`);
    }
  }

  return { passed: reasons.length === 0, reasons };
}
