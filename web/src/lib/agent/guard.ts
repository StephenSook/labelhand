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
  if (/\bonly\b/i.test(answer.summary) && knownWindowIndices.size !== 1) {
    reasons.push(`The summary says only, but check_tank returned ${knownWindowIndices.size} windows.`);
  }

  const toolNumbers = numbersIn(toolText);
  for (const number of numbersIn(answer.summary)) {
    if (!toolNumbers.has(number)) {
      reasons.push(`Number ${number} did not appear in a tool result.`);
    }
  }

  return { passed: reasons.length === 0, reasons };
}
