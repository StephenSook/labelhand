// Shapes and helpers for the label time machine (/changes/<reg>): the committed rule and planner-hour comparison
// (public/data/changes.json, written by tools/label_changes.py) and the live version list and text comparison.

import type { LabelTextDiff, TextChange } from "./label-diff";

export type RuleView = {
  id: string;
  page: number;
  param: string;
  op: string | null;
  value: number | null;
  value2: number | null;
  unit: string | null;
  modality: string;
  quote: string;
  planner: "acting" | "advisory" | "not read";
  spray_condition: boolean;
};

export type RuleEntry = {
  key: string;
  // Whether one label prints this sentence and the other does not. False means both labels print it the same way
  // and only the two compiles read it differently.
  label_changed: boolean;
  shipped?: RuleView;
  previous?: RuleView;
  fields?: string[];
};

export type HoursMoved = {
  hours: number;
  changed: number;
  transitions: Record<string, number>;
  states_shipped: Record<string, number>;
  states_previous: Record<string, number>;
  moved: Array<{ start: string; shipped: string; previous: string; only_shipped: string[]; only_previous: string[] }>;
  hours_citing_only_shipped: Record<string, number>;
  hours_citing_only_previous: Record<string, number>;
};

export type LabelChangesEntry = {
  product: string;
  shortName: string;
  shipped: { accepted: string; url: string; sha256: string };
  previous: { accepted?: string; url?: string; sha256?: string; pages?: number };
  versions_listed: number;
  compiled: boolean;
  why_not_compiled?: string;
  compile_cost_usd?: number;
  rules?: {
    shipped_count: number;
    previous_count: number;
    shipped_planner: number;
    previous_planner: number;
    added: RuleEntry[];
    removed: RuleEntry[];
    changed: RuleEntry[];
    unchanged: number;
  };
  hours?: Record<string, { tank: HoursMoved; alone: HoursMoved }>;
};

export type ChangesData = {
  forecasts: Record<string, { file: string; point: string; forecast_fetched_utc: string; hours: number }>;
  labels: Record<string, LabelChangesEntry>;
  compile_cost_usd: number;
};

export type VersionRow = { fileName: string; accepted: string; url: string };

export type VersionList = {
  reg: string;
  product: string;
  status: string;
  cancelled: boolean;
  versions: VersionRow[];
  fetchedAt: string;
  stale?: { reason: string };
};

export type VersionDiff = {
  reg: string;
  from: VersionRow & { sha256: string; pages: number };
  to: VersionRow & { sha256: string; pages: number };
  diff: LabelTextDiff;
};

const PPLS_FILE = /^\d{6}-\d{5}-\d{8}\.pdf$/;

export function fileNameOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

// Accepted dates are calendar dates, so they are formatted in UTC and never shift a day.
export function formatAccepted(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(parsed);
}

// "1", "1 and 2", "1, 2 and 3".
export function listText(items: Array<string | number>): string {
  const words = items.map(String);
  return words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorOf(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string" && value.error ? value.error : fallback;
}

function versionRow(value: unknown): VersionRow | null {
  if (!isRecord(value)) return null;
  const { fileName, accepted, url } = value;
  if (typeof fileName !== "string" || !PPLS_FILE.test(fileName) || typeof accepted !== "string" || typeof url !== "string") return null;
  return { fileName, accepted, url };
}

// The versions route answers a list, or { error } with a plain sentence for the page to show as it is.
export function parseVersionList(status: number, value: unknown): VersionList {
  if (status !== 200) throw new Error(errorOf(value, `The label version list returned HTTP ${status}.`));
  if (!isRecord(value) || typeof value.reg !== "string" || !Array.isArray(value.versions)) {
    throw new Error("The label version list was not in the expected shape.");
  }
  const versions = value.versions.map(versionRow);
  if (versions.some((row) => row === null)) throw new Error("The label version list named a file that is not an EPA PPLS label.");
  return {
    reg: value.reg,
    product: typeof value.product === "string" ? value.product : "",
    status: typeof value.status === "string" ? value.status : "",
    cancelled: value.cancelled === true,
    versions: versions as VersionRow[],
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
    ...(isRecord(value.stale) && typeof value.stale.reason === "string" ? { stale: { reason: value.stale.reason } } : {}),
  };
}

export function parseVersionDiff(status: number, value: unknown): VersionDiff {
  if (status !== 200) throw new Error(errorOf(value, `The label comparison returned HTTP ${status}.`));
  const side = (raw: unknown) => {
    const row = versionRow(raw);
    if (!row || !isRecord(raw) || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256) || typeof raw.pages !== "number") return null;
    return { ...row, sha256: raw.sha256, pages: raw.pages };
  };
  if (!isRecord(value) || typeof value.reg !== "string" || !isRecord(value.diff) || !Array.isArray(value.diff.changes)) {
    throw new Error("The label comparison was not in the expected shape.");
  }
  const from = side(value.from);
  const to = side(value.to);
  if (!from || !to) throw new Error("The label comparison did not name both PDFs it read.");
  return { reg: value.reg, from, to, diff: value.diff as LabelTextDiff };
}

// The pair the page opens on: the label Labelhand plans with (or the newest) against the one accepted before it.
export function defaultPair(versions: VersionRow[], shippedFile?: string): { from: string; to: string } | null {
  const toIndex = Math.max(0, shippedFile ? versions.findIndex((row) => row.fileName === shippedFile) : 0);
  const to = versions[toIndex];
  const from = versions[toIndex + 1];
  return to && from ? { from: from.fileName, to: to.fileName } : null;
}

// The older of two files goes first, whichever order they were picked in.
export function orderedPair(versions: VersionRow[], a: string, b: string): { from: string; to: string } | null {
  const ia = versions.findIndex((row) => row.fileName === a);
  const ib = versions.findIndex((row) => row.fileName === b);
  if (ia < 0 || ib < 0 || ia === ib) return null;
  return ia > ib ? { from: a, to: b } : { from: b, to: a };
}

const OPERATOR: Record<string, string> = { lt: "below", lte: "at or below", gt: "above", gte: "at or above", eq: "equal to", between: "between" };

export function modalityText(modality: string): string {
  return modality === "MUST_NOT" ? "MUST NOT" : modality;
}

// "MUST NOT, wind_speed_mph above 10 mph" from a compiled rule, in the rule's own terms.
export function ruleText(rule: RuleView): string {
  const amount = rule.value === null
    ? ""
    : rule.op === "between" && rule.value2 !== null
      ? ` between ${rule.value} and ${rule.value2}`
      : ` ${OPERATOR[rule.op ?? ""] ?? ""} ${rule.value}`.replace("  ", " ");
  const unit = rule.value !== null && rule.unit ? ` ${rule.unit}` : "";
  return `${modalityText(rule.modality)}, ${rule.param}${amount}${unit}`;
}

const PLANNER_RANK = { acting: 0, advisory: 1, "not read": 2 } as const;

// What an applicator needs first: sentences the label changed, then rules the planner acts on, then spray conditions.
export function sortRuleEntries(entries: RuleEntry[]): RuleEntry[] {
  const rule = (entry: RuleEntry) => (entry.shipped ?? entry.previous) as RuleView;
  const planner = (entry: RuleEntry) => Math.min(...[entry.shipped, entry.previous].filter((r): r is RuleView => Boolean(r)).map((r) => PLANNER_RANK[r.planner]));
  return [...entries].sort((a, b) =>
    Number(b.label_changed) - Number(a.label_changed)
    || planner(a) - planner(b)
    || Number(rule(b).spray_condition) - Number(rule(a).spray_condition)
    || rule(a).page - rule(b).page,
  );
}

export function quoteForKey(entry: LabelChangesEntry, key: string): string | null {
  const rules = entry.rules;
  if (!rules) return null;
  const found = [...rules.added, ...rules.removed, ...rules.changed].find((item) => item.key === key);
  return found ? (found.previous ?? found.shipped)?.quote ?? null : null;
}

export function conditionChanges(changes: TextChange[]): { spray: TextChange[]; other: TextChange[] } {
  return { spray: changes.filter((change) => change.conditions.length > 0), other: changes.filter((change) => change.conditions.length === 0) };
}
