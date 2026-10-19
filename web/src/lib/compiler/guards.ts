import spec from "./spec.generated.json";

export type GuardRule = Record<string, unknown> & {
  quote?: string;
  unit?: string | null;
  value?: number | null;
  value2?: number | null;
};

const fold = spec.FOLD as Record<string, string>;
const vulgar = spec.VULGAR as Record<string, number>;
const vulgarCharacters = Object.keys(vulgar).join("");
const mixedPattern = new RegExp(`(\\d+)\\s*([${vulgarCharacters}])`, "g");
const numberPattern = /\d+(?:\.\d+)?/g;
const fractionPattern = /(\d+)\s*\/\s*(\d+)/g;

export function norm(value: string): string {
  const folded = Array.from(value, (character) => fold[character] ?? character).join("");
  return folded
    .replace(/-\s*\n\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function squash(value: string): string {
  return value.replace(/\s+/g, "");
}

export function numStr(value: number): string {
  return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
}

export function quoteNumbers(quote: string): number[] {
  const plain = Array.from(quote.matchAll(numberPattern), (match) => Number(match[0]));
  const fractions = Array.from(quote.matchAll(fractionPattern), (match) => {
    const denominator = Number(match[2]);
    return denominator === 0 ? null : Number(match[1]) / denominator;
  }).filter((value): value is number => value !== null);
  const mixed = Array.from(quote.matchAll(mixedPattern), (match) => Number(match[1]) + vulgar[match[2]]);
  return [...plain, ...fractions, ...mixed];
}

export function restoreUnits<T extends GuardRule>(rule: T): T {
  const quote = norm(rule.quote ?? "");
  const unit = (rule.unit ?? "").toLowerCase().trim();
  const numbers = quoteNumbers(quote);
  const output = { ...rule } as GuardRule;

  for (const key of ["value", "value2"] as const) {
    const value = rule[key];
    if (value === null || value === undefined || numbers.some((number) => Math.abs(value - number) < 1e-9)) {
      continue;
    }
    for (const conversion of spec.CONVERSIONS) {
      if (!conversion.destination_units.includes(unit) || !conversion.source_words.some((word) => quote.includes(word))) {
        continue;
      }
      const match = numbers.find((number) => Math.abs(number * conversion.factor - value) < 1e-6);
      if (match === undefined) continue;
      output[key] = match;
      output.unit = conversion.source_words[0];
      output.unit_restored = `${numStr(value)} ${unit} -> ${numStr(match)} ${conversion.source_words[0]} (model conversion undone in code)`;
      break;
    }
  }

  return output as T;
}

export function guard(rule: GuardRule, pageTextNorm: string): string | null {
  const quote = norm(rule.quote ?? "");
  if (quote.length < 8) return "QUOTE_TOO_SHORT";
  if (quote.includes("...") || quote.includes("\u2026")) return "QUOTE_SPLICED";
  if (!pageTextNorm.includes(quote) && !squash(pageTextNorm).includes(squash(quote))) {
    return "QUOTE_NOT_IN_PAGE";
  }

  const numbers = new Set(quoteNumbers(quote).map(numStr));
  for (const key of ["value", "value2"] as const) {
    const value = rule[key];
    if (value === null || value === undefined || numbers.has(numStr(value))) continue;
    if (quote.includes("\uFFFD")) return `UNREADABLE_GLYPH:${key}=${numStr(value)}`;
    return `NUMBER_NOT_IN_QUOTE:${key}=${numStr(value)}`;
  }
  return null;
}
