import type { Citation, EvaluatedHour, Rule } from "@/engine";

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ForecastWindow {
  start: string;
  end: string;
  length: number;
}

export interface ClauseImpact extends Citation {
  hourCount: number;
  blockedHours: number;
  fieldCheckHours: number;
}

export interface ProductImpact {
  product: string;
  hourCount: number;
}

function citationIdentity(citation: Citation): string {
  return JSON.stringify([
    citation.product,
    citation.rule,
    citation.page,
    citation.quote,
  ]);
}

export function rankLimitingClauses(hours: EvaluatedHour[]): ClauseImpact[] {
  const impacts = new Map<string, ClauseImpact>();
  for (const hour of hours) {
    const seenThisHour = new Set<string>();
    for (const [citation, effect] of [
      ...hour.blocked.map((item) => [item, "blocked"] as const),
      ...hour.checks.map((item) => [item, "field-check"] as const),
    ]) {
      const key = citationIdentity(citation);
      if (seenThisHour.has(key)) continue;
      seenThisHour.add(key);
      const impact = impacts.get(key) ?? {
        ...citation,
        hourCount: 0,
        blockedHours: 0,
        fieldCheckHours: 0,
      };
      impact.hourCount += 1;
      if (effect === "blocked") impact.blockedHours += 1;
      else impact.fieldCheckHours += 1;
      impacts.set(key, impact);
    }
  }
  return [...impacts.values()].sort((a, b) =>
    b.hourCount - a.hourCount ||
    b.blockedHours - a.blockedHours ||
    a.product.localeCompare(b.product) ||
    String(a.page).localeCompare(String(b.page)) ||
    a.quote.localeCompare(b.quote),
  );
}

export function rankLimitingProducts(hours: EvaluatedHour[]): ProductImpact[] {
  const counts = new Map<string, number>();
  for (const hour of hours) {
    const products = new Set([...hour.blocked, ...hour.checks].map((citation) => citation.product));
    for (const product of products) counts.set(product, (counts.get(product) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([product, hourCount]) => ({ product, hourCount }))
    .sort((a, b) => b.hourCount - a.hourCount || a.product.localeCompare(b.product));
}

export function isTankCompositionRule(rule: Rule): boolean {
  return (
    (rule.modality === "MUST" || rule.modality === "MUST_NOT") &&
    (rule.param === "night_temperature_f" || rule.param === "air_temperature_f") &&
    /\buse\b[^.]*\balone\b/.test(rule.quote.toLowerCase())
  );
}

export function forecastPermittedWindows(
  hours: EvaluatedHour[],
  jobHours = 3,
): ForecastWindow[] {
  if (!Number.isInteger(jobHours) || jobHours < 1) {
    throw new RangeError("jobHours must be a positive integer.");
  }

  const windows: ForecastWindow[] = [];
  let run: EvaluatedHour[] = [];

  const finishRun = () => {
    if (run.length >= jobHours) {
      const lastStart = Date.parse(run.at(-1)!.start);
      windows.push({
        start: run[0].start,
        end: new Date(lastStart + ONE_HOUR_MS).toISOString(),
        length: run.length,
      });
    }
    run = [];
  };

  for (const hour of hours) {
    const previous = run.at(-1);
    const followsPrevious =
      !previous || Date.parse(hour.start) - Date.parse(previous.start) === ONE_HOUR_MS;
    if (hour.state !== "PERMITTED" || !followsPrevious) {
      finishRun();
    }
    if (hour.state === "PERMITTED") {
      run.push(hour);
    }
  }
  finishRun();

  return windows;
}
