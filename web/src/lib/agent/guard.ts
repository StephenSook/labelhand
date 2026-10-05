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

// The guard checks what can be checked structurally: every cited rule id, every window index and
// every number in the summary must come from a tool result. It deliberately does NOT read window
// counts out of the prose. Two production false refusals (2026-10-05: "only the two windows ...",
// then "7 PM. Wed window" read as seven) and an adversarial review ("Only one available window
// starts at three PM; the other ...") showed that a count scoped by a predicate cannot be told apart
// from a total by pattern matching. The prompt tells the model not to state counts, and the page
// lists every returned window under the answer, so a wrong count would sit beside the true list.
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

  return { passed: reasons.length === 0, reasons };
}
