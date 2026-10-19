const ACTING = new Set(["MUST", "MUST_NOT"]);

export interface MergeRule extends Record<string, unknown> {
  param: string;
  quote: string;
  modality: string;
}

export interface MergeReport<Rule extends MergeRule = MergeRule> extends Record<string, unknown> {
  product?: unknown;
  reg?: unknown;
  accepted: Rule[];
}

export type MergedRule<Rule extends MergeRule> = Rule & {
  found_in_runs: string[];
  modality_by_run: Record<string, string>;
  modality_vote: Record<string, number>;
};

export type MergedReport<Rule extends MergeRule, Report extends MergeReport<Rule>> = Report & {
  accepted: Array<MergedRule<Rule>>;
  merged_from: string[];
};

function ruleKey(rule: MergeRule): string {
  const normalizedQuote = rule.quote.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
  return JSON.stringify([rule.param, normalizedQuote]);
}

function preferredModality(current: string, candidate: string): string {
  if (!ACTING.has(current) && ACTING.has(candidate)) return candidate;
  return current;
}

function winningModality(
  modalityByRun: Record<string, string>,
  runNames: string[],
): { winner: string; vote: Record<string, number> } {
  const counts = new Map<string, number>();
  for (const modality of Object.values(modalityByRun)) {
    counts.set(modality, (counts.get(modality) ?? 0) + 1);
  }

  let winner = Array.from(counts).find(([, count]) => count >= 2)?.[0];
  if (winner === undefined) {
    winner = runNames.map((runName) => modalityByRun[runName]).find((modality) => ACTING.has(modality));
  }
  winner ??= Object.values(modalityByRun)[0];

  const vote = Object.fromEntries(Array.from(counts).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
  return { winner, vote };
}

export function mergeReports<Rule extends MergeRule, Report extends MergeReport<Rule>>(
  reports: Report[],
  runNames: string[],
): MergedReport<Rule, Report> {
  if (reports.length === 0 || reports.length !== runNames.length) {
    throw new Error("reports and run_names must be non-empty and have the same length");
  }

  const { product, reg } = reports[0];
  if (reports.slice(1).some((report) => report.product !== product || report.reg !== reg)) {
    throw new Error("all merged reports must describe the same product and registration");
  }

  const candidates = new Map<string, Map<string, Rule>>();
  reports.forEach((report, reportIndex) => {
    const runName = runNames[reportIndex];
    for (const rule of report.accepted) {
      const key = ruleKey(rule);
      const byRun = candidates.get(key) ?? new Map<string, Rule>();
      candidates.set(key, byRun);
      const current = byRun.get(runName);
      if (current === undefined || preferredModality(current.modality, rule.modality) !== current.modality) {
        byRun.set(runName, rule);
      }
    }
  });

  const accepted: Array<MergedRule<Rule>> = [];
  for (const byRun of candidates.values()) {
    const modalityByRun = Object.fromEntries(
      runNames
        .filter((runName) => byRun.has(runName))
        .map((runName) => [runName, byRun.get(runName)!.modality]),
    );
    const { winner, vote } = winningModality(modalityByRun, runNames);
    const selected = runNames
      .map((runName) => byRun.get(runName))
      .find((rule) => rule?.modality === winner);
    if (selected === undefined) throw new Error("merged modality vote could not select a rule");
    accepted.push({
      ...selected,
      found_in_runs: Object.keys(modalityByRun),
      modality_by_run: modalityByRun,
      modality_vote: vote,
    });
  }

  return {
    ...reports[0],
    accepted,
    merged_from: runNames,
  };
}
