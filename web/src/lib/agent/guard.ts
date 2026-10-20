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

// A comma joins digits only as a thousands separator ("1,236"), so "pages 7,8" reads as 7 and 8.
// A minus sign counts only when no letter, digit or dot comes right before it, so "3-7 PM" and
// "264-700" read as positive numbers. Thousands separators are dropped before comparing.
const NUMBER_PATTERN = /(?:(?<![\w.])-)?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g;
const PLAIN_NUMBER_PATTERN = /(?:(?<![\w.])-)?\d+(?:\.\d+)?/g;

function numbersIn(value: string): Set<string> {
  return new Set((value.match(NUMBER_PATTERN) ?? []).map((match) => match.replace(/,/g, "")));
}

// Tool results are JSON, where "[1,236]" is two numbers. Both readings count as present.
function toolNumbersIn(value: string): Set<string> {
  return new Set([...numbersIn(value), ...(value.match(PLAIN_NUMBER_PATTERN) ?? [])]);
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

// final_answer.summary has a JSON-schema maxLength, and Token Factory's constrained decoding stops
// the string at that length even mid-word. Production 2026-10-19 (run 39294396284): a zero-window
// week produced a 400-character list of restrictions cut at "wind speeds >10", and every retry
// repeated it because the only reason given was the missing full stop. The summary is never
// trimmed here: a review showed "permitted at 3 p.m. only if ..." would trim to an unconditional
// claim. The guard instead names the cut so the retry is asked for a shorter answer.
export const SUMMARY_MAX_CHARACTERS = 400;

// Typographic spaces Nemotron puts inside "10 mph" or "48 F". U+202F failed the script check in
// that same run although it is only a space. Replacing a space with a space changes no claim.
const TYPOGRAPHIC_SPACES = /[\u2000-\u200A\u202F\u205F]/g;

export type PreparedAnswer = {
  answer: FinalAnswerArgs;
  notes: string[];
};

export function prepareFinalAnswer(answer: FinalAnswerArgs): PreparedAnswer {
  const summary = answer.summary.replace(TYPOGRAPHIC_SPACES, " ");
  if (summary === answer.summary) return { answer, notes: [] };
  return {
    answer: { ...answer, summary },
    notes: ["Typographic spaces in the summary were replaced with ordinary spaces."],
  };
}

const COUNT_WORDS = ["zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const COUNT_WORD_VALUES = new Map(COUNT_WORDS.map((word, index) => [word, index === 0 ? 0 : index + 1]));
// "156 blocked windows", "two forecast-permitted windows", "3 4-hour windows". A length adjective
// such as "4-hour" may sit between the count and the noun; a bare "hours" may not, so "156 hours of
// blocked windows" is not read as a window count.
const WINDOW_COUNT_CLAIM = new RegExp(
  `\\b(\\d+|${COUNT_WORDS.join("|")})((?:\\s+(?!hours?\\b)(?:[A-Za-z][A-Za-z\\u2010\\u2011-]*|\\d+[\\u2010\\u2011-]hours?)){0,3})\\s+windows\\b`,
  "gi",
);
// "field-check" is not here: a returned window is forecast-permitted and can still need label field
// checks ("two forecast-permitted field-check-required windows" is true).
// "non-blocked" and "not blocked" are negations, so the word must not follow a hyphen or "not".
const NON_PERMITTED_MODIFIER = /(?<![\w-])(?<!\bnot\s)(?:blocked|blocking|closed|denied|unpermitted)\b/i;

// A count scoped by a predicate ("two windows start before noon") can never exceed the number of
// windows returned, so only a count above that number is rejected. Windows are permitted spans by
// definition, so a count of "blocked windows" is always a mislabelled hour total. An undercount
// ("zero windows were returned" with four listed) passes because a scoped count cannot be told
// apart from a total; it errs toward not spraying, and the page lists every returned window.
function windowCountReasons(summary: string, permittedCount: number): string[] {
  const reasons: string[] = [];
  for (const match of summary.matchAll(WINDOW_COUNT_CLAIM)) {
    const token = match[1].toLowerCase();
    const value = /^\d+$/.test(token) ? Number(token) : COUNT_WORD_VALUES.get(token);
    if (value === undefined) continue;
    const modifiers = match[2] ?? "";
    if (NON_PERMITTED_MODIFIER.test(modifiers)) {
      reasons.push(`The summary says "${match[0].trim()}", but windows are forecast-permitted spans; check_tank counts are hours, not windows.`);
    } else if (value > permittedCount) {
      reasons.push(`The summary says "${match[0].trim()}", but check_tank returned ${permittedCount} permitted windows.`);
    }
  }
  return reasons;
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

// "No application window is permitted" while check_tank returned windows (Ask the tank, local run
// 2026-10-20, wind-limit question): the count check reads digits and number words, not "no".
// Only an unscoped denial of the whole list is refused. "No window opens before Thursday", "there is
// no window on Monday" and "no window is blocked by wind" can all be true while windows came back.
const NO_WINDOW_CLAIM = new RegExp(
  `\\bno(?:\\s+(?:${WINDOW_MODIFIER}|application|spray|spraying|job)){0,4}\\s+windows?\\b`,
  "i",
);
// "No 3-hour window" denies the list only when 3 hours is the job check_tank ran.
const NO_LENGTH_WINDOW_CLAIM = /\bno\s+(\d+)-hour\s+windows?\b/i;
const DENIAL_SCOPE = /\b(?:before|after|until|on|but|except|blocked|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|morning|afternoon|evening|night)\b/i;

// "Wed window blocked by 264-418 rain clause" about a window check_tank returned as
// forecast-permitted (local run 2026-10-20, 4-hour question). A returned window is never blocked.
// "All other windows are blocked" is the exclusivity check's claim, and "are not blocked" and "no
// window is blocked" are denials.
const WINDOW_CALLED_BLOCKED = /(?<!\b(?:other|no)\s)\bwindows?\b(?:\s+(?!not\b|never\b)[\w'-]+){0,2}?\s+(?:(?:is|are|was|were)\s+)?(?:blocked|not permitted)\b/i;

function noWindowReasons(summary: string, permittedCount: number, jobHours: number | undefined): string[] {
  if (permittedCount === 0) return [];
  const reasons: string[] = [];
  for (const sentence of sentencesOf(summary)) {
    if (DENIAL_SCOPE.test(sentence)) continue;
    const none = sentence.match(NO_WINDOW_CLAIM);
    const length = sentence.match(NO_LENGTH_WINDOW_CLAIM);
    const denial = none?.[0] ?? (length && Number(length[1]) === jobHours ? length[0] : undefined);
    if (denial) reasons.push(`The summary says "${denial}", but check_tank returned ${permittedCount} permitted windows.`);
  }
  const blocked = summary.match(WINDOW_CALLED_BLOCKED);
  if (blocked) reasons.push(`The summary says "${blocked[0]}", but every window check_tank returned is forecast-permitted.`);
  return reasons;
}

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

// "for that window" / "in this window", plus the same modifiers exclusivity allows and a
// length adjective such as "6-hour". "not for that window" is a denial, not an attribution.
// "for the window" is a different phrase and is not matched.
const SINGLE_WINDOW_SCOPE = new RegExp(
  `(?<!\\bnot\\s)\\b(?:for|in)\\s+(?:this|that)(?:\\s+(?:${WINDOW_MODIFIER}|\\d+-hour)){0,4}\\s+window\\b`,
  "i",
);

function scopeReasons(
  summary: string,
  successfulResults: readonly ToolResultRecord[],
  windowRecords: readonly Record<string, unknown>[],
): string[] {
  const weekTotals = new Set<string>();
  for (const entry of successfulResults) {
    if (entry.name !== "check_tank" || !isRecord(entry.result) || !isRecord(entry.result.counts)) continue;
    for (const value of Object.values(entry.result.counts)) {
      if (typeof value === "number" && Number.isFinite(value)) weekTotals.add(String(value));
    }
  }
  if (weekTotals.size === 0) return [];
  // counts.* is a forecast-wide hour total. windows[].hours is only the permitted span.
  // There is no per-window state split, so equality against that window cannot be checked.
  // Skip a total whose digits are also a returned window's length or index: "6 hours for
  // that window" and "Window 0" use those digits for the window itself. A total of 0 is
  // the common case of that index collision.
  const windowDigits = new Set<string>();
  for (const window of windowRecords) {
    for (const value of [window.hours, window.index]) {
      if (typeof value === "number" && Number.isFinite(value)) windowDigits.add(String(value));
    }
  }
  const misattributed: string[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(summary)) {
    if (!SINGLE_WINDOW_SCOPE.test(sentence)) continue;
    for (const number of numbersIn(sentence)) {
      if (!weekTotals.has(number) || windowDigits.has(number) || seen.has(number)) continue;
      seen.add(number);
      misattributed.push(number);
    }
  }
  if (misattributed.length === 0) return [];
  return [
    `The summary attributes forecast-wide counts (${misattributed.join(", ")}) to a single window. Those counts cover the whole forecast, and check_tank does not return a per-window split, so the guard cannot check them against that window. A week total that equals a returned window's hours or index is not rejected, because those digits can name the window rather than the total.`,
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
    if (answer.summary.length >= SUMMARY_MAX_CHARACTERS - 5) {
      reasons.push(`The summary reached the ${SUMMARY_MAX_CHARACTERS}-character limit and was cut off. Write a shorter summary, under 300 characters.`);
    }
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
// permitted window. Week-total scope is the same kind of check. check_tank counts are hour
// totals for the whole forecast, and the result has no per-window split of those totals, so a
// number next to "for that window" cannot be proved equal to that window. A sentence that pairs
// a counts value with "for/in this/that window" is rejected unless those digits also equal a
// returned window's hours or index. A plural window count ("156 blocked windows") is rejected when
// it names blocked windows or exceeds the returned window list. The prompt tells the model not to
// state counts, and the page lists every returned window under the answer.
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

  const toolNumbers = toolNumbersIn(toolText);
  for (const number of numbersIn(answer.summary)) {
    if (!toolNumbers.has(number)) {
      reasons.push(`Number ${number} did not appear in a tool result.`);
    }
  }

  reasons.push(...scriptAndEndingReasons(answer));
  reasons.push(...exclusivityReasons(answer.summary, windowRecords.length));
  reasons.push(...windowCountReasons(answer.summary, windowRecords.length));
  const checkedJobHours = isRecord(latestCheck) && typeof latestCheck.job_hours === "number" ? latestCheck.job_hours : undefined;
  reasons.push(...noWindowReasons(answer.summary, windowRecords.length, checkedJobHours));
  reasons.push(...scopeReasons(answer.summary, successfulResults, windowRecords));

  return { passed: reasons.length === 0, reasons };
}

// A limit or "why" answer can be right about the label and still add one false sentence about
// windows: on 2026-10-20 Lightning answered the wind-limit question correctly and then wrote "No
// window is returned" four times while check_tank had returned two. That sentence is removed in code
// and the page says so; the windows the planner returned are listed instead. Anything else the guard
// refuses still sends the answer back to the model.
export type WindowClaimRepair = {
  answer: FinalAnswerArgs;
  removed: string[];
  windowCount: number;
};

export function dropWindowClaims(answer: FinalAnswerArgs, toolResults: readonly ToolResultRecord[]): WindowClaimRepair | null {
  const successful = toolResults.filter((entry) => !(isRecord(entry.result) && typeof entry.result.error === "string"));
  const latestCheck = [...successful].reverse().find((entry) => entry.name === "check_tank")?.result;
  if (!isRecord(latestCheck) || !Array.isArray(latestCheck.windows)) return null;
  const windowIndices = latestCheck.windows
    .filter(isRecord)
    .map((window) => window.index)
    .filter((index): index is number => Number.isInteger(index));
  if (windowIndices.length === 0) return null;
  const jobHours = typeof latestCheck.job_hours === "number" ? latestCheck.job_hours : undefined;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const sentence of sentencesOf(answer.summary)) {
    const claims = noWindowReasons(sentence, windowIndices.length, jobHours);
    if (claims.length > 0) removed.push(sentence);
    else kept.push(sentence);
  }
  if (removed.length === 0 || kept.length === 0) return null;
  return {
    answer: { ...answer, summary: kept.join(" "), window_indices: windowIndices },
    removed,
    windowCount: windowIndices.length,
  };
}
