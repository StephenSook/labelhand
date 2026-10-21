// What changed between two accepted versions of one EPA label, from their PDF text layers. No model reads anything:
// both versions are cut into sentences, the sentences are aligned, and each block that does not align is compared
// word by word. Words compare on letters and digits only, so a moved line break, a split word ("so meone") or a
// changed comma never counts as a change; a moved sentence is counted, not listed.

export type SprayCondition =
  | "wind"
  | "rain"
  | "temperature"
  | "inversion"
  | "buffer"
  | "droplet size"
  | "release height"
  | "boom height"
  | "re-entry";

// The spray conditions an applicator checks before a job, matched as whole words on the sentence text.
const CONDITIONS: ReadonlyArray<[SprayCondition, RegExp]> = [
  ["wind", /\bwind(?:s|speeds?)?\b/],
  ["rain", /\brain(?:s|ing|fall|fast|free|y)?\b/],
  ["temperature", /\btemperatures?\b/],
  ["inversion", /\binversions?\b/],
  ["buffer", /\bbuffers?\b/],
  ["droplet size", /\bdroplets?\b/],
  ["release height", /\brelease heights?\b/],
  ["boom height", /\bboom heights?\b/],
  ["re-entry", /\bre-?\s?entry\b|\brestricted[-\s]entry\b|\brei\b/],
];

export function sprayConditions(text: string): SprayCondition[] {
  const lower = text.toLowerCase();
  return CONDITIONS.filter(([, pattern]) => pattern.test(lower)).map(([name]) => name);
}

type Token = { raw: string; key: string; lineEnd: boolean };

export type Sentence = {
  page: number;
  text: string;
  // Letters and digits of each word, lowercase, and where each word sits in `text`.
  words: Array<{ key: string; start: number; end: number }>;
  key: string;
};

const BULLET = /^[•●▪■‣⁃◦]/u;
const ABBREVIATION = /^(?:[A-Za-z]\.){2,}$|^(?:e\.g|i\.e|etc|no|oz|fl|lb|lbs|gal|qt|pt|approx|min|max|vs|st|dr|mr|ms|inc|co)\.$/i;
const SENTENCE_END = /[.!?;]["')\]]?$/;
const LONG_SENTENCE_WORDS = 40;

export function wordKey(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function tokens(pageText: string): Token[] {
  const out: Token[] = [];
  const pattern = /(\S+)(\s*)/gu;
  for (const match of pageText.matchAll(pattern)) {
    out.push({ raw: match[1], key: wordKey(match[1]), lineEnd: match[2].includes("\n") });
  }
  return out;
}

function sentence(page: number, parts: Token[]): Sentence | null {
  const words: Sentence["words"] = [];
  let text = "";
  for (const token of parts) {
    if (text) text += " ";
    const start = text.length;
    text += token.raw;
    if (token.key) words.push({ key: token.key, start, end: text.length });
  }
  // A run with fewer than three letters is a stray mark, a page number or a table rule, not a sentence.
  if ((text.match(/\p{L}/gu)?.length ?? 0) < 3) return null;
  return { page, text, words, key: words.map((word) => word.key).join("") };
}

// Sentences end at . ! ? or ; (not after an abbreviation such as "a.i." or "fl."), before a bullet, at the end of a
// page, and at a line end once a run reaches 40 words, so a heading glued to a paragraph stays a readable size.
export function sentences(pages: readonly string[]): Sentence[] {
  const out: Sentence[] = [];
  pages.forEach((pageText, index) => {
    const page = index + 1;
    let run: Token[] = [];
    const flush = () => {
      const built = run.length ? sentence(page, run) : null;
      if (built) out.push(built);
      run = [];
    };
    for (const token of tokens(pageText)) {
      if (BULLET.test(token.raw) && run.length) flush();
      run.push(token);
      const ends = SENTENCE_END.test(token.raw) && !ABBREVIATION.test(token.raw);
      if (ends || (token.lineEnd && run.length >= LONG_SENTENCE_WORDS)) flush();
    }
    flush();
  });
  return out;
}

type Op = { kind: "equal"; a: number; b: number } | { kind: "delete"; a: number } | { kind: "insert"; b: number };

// The cells an alignment needs once the shared start and end are set aside.
export const SENTENCE_CAP = 9_000_000;

function middle(a: readonly string[], b: readonly string[]): { start: number; endA: number; endB: number; cells: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { start, endA, endB, cells: (endA - start) * (endB - start) };
}

// Longest common subsequence alignment of two key lists. Inputs above `cap` cells are not aligned at all, which
// reports the whole block as removed and added rather than guessing.
export function align(a: readonly string[], b: readonly string[], cap = SENTENCE_CAP): Op[] {
  const { start, endA, endB } = middle(a, b);
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: "equal", a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n * m > cap) {
    for (let i = 0; i < n; i += 1) ops.push({ kind: "delete", a: start + i });
    for (let j = 0; j < m; j += 1) ops.push({ kind: "insert", b: start + j });
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        ops.push({ kind: "equal", a: start + i, b: start + j });
        i += 1;
        j += 1;
      } else if (j < m && (i === n || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
        ops.push({ kind: "insert", b: start + j });
        j += 1;
      } else {
        ops.push({ kind: "delete", a: start + i });
        i += 1;
      }
    }
  }
  for (let k = 0; endA + k < a.length; k += 1) ops.push({ kind: "equal", a: endA + k, b: endB + k });
  return ops;
}

export type ChangeSide = {
  page: number;
  pages: number[];
  text: string;
  // Character ranges of `text` whose words are not in the other version.
  marks: Array<[number, number]>;
  // The sentences `text` joins, each with its page, so a sentence can be found on its own page of the PDF.
  parts: Array<{ page: number; text: string; marked: boolean }>;
};

export type TextChange = {
  kind: "added" | "removed" | "changed";
  before: ChangeSide | null;
  after: ChangeSide | null;
  conditions: SprayCondition[];
};

export type LabelTextDiff = {
  changes: TextChange[];
  sentences: { from: number; to: number };
  // Sentences found unchanged somewhere else in the other version.
  moved: number;
  // Blocks that differ only in spacing, line breaks or punctuation.
  formatting: number;
  // Pages with no readable text layer (under 50 characters), usually scanned pages.
  blankPages: { from: number[]; to: number[] };
  // A version with no text layer on any page (a scan) cannot be compared: listing every sentence of the other one
  // as added or removed would claim a change nobody made.
  unreadable: "from" | "to" | null;
  // Two versions too long and too different to align within the server's memory: nothing is listed rather than
  // every sentence reported as removed, added or moved.
  tooLong: boolean;
};

type WordRef = { sentence: number; word: number };

function blankPages(pages: readonly string[]): number[] {
  return pages.flatMap((text, index) => (text.replace(/\s/g, "").length < 50 ? [index + 1] : []));
}

function side(list: Sentence[], ids: number[], marks: Map<number, Set<number>>): ChangeSide {
  let text = "";
  const ranges: Array<[number, number]> = [];
  for (const id of ids) {
    if (text) text += " ";
    const offset = text.length;
    const current = list[id];
    text += current.text;
    for (const word of [...(marks.get(id) ?? [])].sort((x, y) => x - y)) {
      const { start, end } = current.words[word];
      const last = ranges[ranges.length - 1];
      // Neighbouring marked words become one range, so a changed phrase reads as one highlight.
      if (last && offset + start - last[1] <= 1) last[1] = offset + end;
      else ranges.push([offset + start, offset + end]);
    }
  }
  const pages = [...new Set(ids.map((id) => list[id].page))];
  const parts = ids.map((id) => ({ page: list[id].page, text: list[id].text, marked: (marks.get(id)?.size ?? 0) > 0 }));
  return { page: pages[0], pages, text, marks: ranges, parts };
}

export function diffLabelText(fromPages: readonly string[], toPages: readonly string[]): LabelTextDiff {
  const blank = { from: blankPages(fromPages), to: blankPages(toPages) };
  const unreadable = blank.from.length === fromPages.length ? "from" : blank.to.length === toPages.length ? "to" : null;
  const before = sentences(fromPages);
  const after = sentences(toPages);
  const beforeKeys = before.map((s) => s.key);
  const afterKeys = after.map((s) => s.key);
  const tooLong = !unreadable && middle(beforeKeys, afterKeys).cells > SENTENCE_CAP;
  if (unreadable || tooLong) {
    return { changes: [], sentences: { from: before.length, to: after.length }, moved: 0, formatting: 0, blankPages: blank, unreadable, tooLong };
  }
  const top = align(beforeKeys, afterKeys);
  const changes: TextChange[] = [];
  let formatting = 0;

  // Blocks of sentences between aligned anchors.
  let k = 0;
  while (k < top.length) {
    if (top[k].kind === "equal") {
      k += 1;
      continue;
    }
    const oldIds: number[] = [];
    const newIds: number[] = [];
    while (k < top.length && top[k].kind !== "equal") {
      const op = top[k];
      if (op.kind === "delete") oldIds.push(op.a);
      if (op.kind === "insert") newIds.push(op.b);
      k += 1;
    }
    const oldWords: WordRef[] = oldIds.flatMap((id) => before[id].words.map((_, word) => ({ sentence: id, word })));
    const newWords: WordRef[] = newIds.flatMap((id) => after[id].words.map((_, word) => ({ sentence: id, word })));
    const oldKeys = oldWords.map((ref) => before[ref.sentence].words[ref.word].key);
    const newKeys = newWords.map((ref) => after[ref.sentence].words[ref.word].key);
    if (oldKeys.join("") === newKeys.join("")) {
      formatting += 1;
      continue;
    }

    const words = align(oldKeys, newKeys, 4_000_000);
    // The sentences on the other side that each sentence shares an aligned word with.
    const oldPartners = new Map<number, Set<number>>();
    const newPartners = new Map<number, Set<number>>();
    for (const op of words) {
      if (op.kind !== "equal") continue;
      const i = oldWords[op.a].sentence;
      const j = newWords[op.b].sentence;
      oldPartners.set(i, (oldPartners.get(i) ?? new Set<number>()).add(j));
      newPartners.set(j, (newPartners.get(j) ?? new Set<number>()).add(i));
    }
    type Item = { a: Set<number>; b: Set<number>; deleted: number[]; inserted: number[] };
    const items: Item[] = [];
    let lastEqual: Op | undefined;
    let w = 0;
    while (w < words.length) {
      if (words[w].kind === "equal") {
        lastEqual = words[w];
        w += 1;
        continue;
      }
      const deleted: number[] = [];
      const inserted: number[] = [];
      while (w < words.length && words[w].kind !== "equal") {
        const run = words[w];
        if (run.kind === "delete") deleted.push(run.a);
        if (run.kind === "insert") inserted.push(run.b);
        w += 1;
      }
      // A word split or joined by the PDF ("so meone" and "someone") has the same letters, so it is not a change.
      if (deleted.map((i) => oldKeys[i]).join("") === inserted.map((j) => newKeys[j]).join("")) continue;
      // Whole sentences added or removed are listed one by one, with no other side.
      const wholeSentences = (picked: number[], refs: WordRef[], list: Sentence[]) => {
        const counts = new Map<number, number>();
        for (const index of picked) counts.set(refs[index].sentence, (counts.get(refs[index].sentence) ?? 0) + 1);
        return new Set([...counts].filter(([id, count]) => count === list[id].words.length).map(([id]) => id));
      };
      const wholeOld = wholeSentences(deleted, oldWords, before);
      const wholeNew = wholeSentences(inserted, newWords, after);
      for (const id of wholeOld) items.push({ a: new Set([id]), b: new Set(), deleted: deleted.filter((i) => oldWords[i].sentence === id), inserted: [] });
      for (const id of wholeNew) items.push({ a: new Set(), b: new Set([id]), deleted: [], inserted: inserted.filter((j) => newWords[j].sentence === id) });
      const partDeleted = deleted.filter((i) => !wholeOld.has(oldWords[i].sentence));
      const partInserted = inserted.filter((j) => !wholeNew.has(newWords[j].sentence));
      if (!partDeleted.length && !partInserted.length) continue;
      // Words added to or taken from a sentence that is still there show that sentence on the other side too: the
      // sentence its unchanged words align with, or, if none do, the one around the nearest unchanged word.
      const a = new Set(partDeleted.map((i) => oldWords[i].sentence));
      const b = new Set(partInserted.map((j) => newWords[j].sentence));
      if (a.size === 0) for (const j of b) newPartners.get(j)?.forEach((i) => a.add(i));
      if (b.size === 0) for (const i of a) oldPartners.get(i)?.forEach((j) => b.add(j));
      const anchor = lastEqual ?? words[w];
      if (a.size === 0 && anchor?.kind === "equal") a.add(oldWords[anchor.a].sentence);
      if (b.size === 0 && anchor?.kind === "equal") b.add(newWords[anchor.b].sentence);
      items.push({ a, b, deleted: partDeleted, inserted: partInserted });
    }

    // Changes that share a sentence are one change.
    const merged: Item[] = [];
    for (const item of items) {
      const target: Item = { a: new Set(item.a), b: new Set(item.b), deleted: [...item.deleted], inserted: [...item.inserted] };
      for (const other of merged.filter((m) => [...item.a].some((id) => m.a.has(id)) || [...item.b].some((id) => m.b.has(id)))) {
        other.a.forEach((id) => target.a.add(id));
        other.b.forEach((id) => target.b.add(id));
        target.deleted.push(...other.deleted);
        target.inserted.push(...other.inserted);
        merged.splice(merged.indexOf(other), 1);
      }
      merged.push(target);
    }

    for (const item of merged) {
      const oldMarks = new Map<number, Set<number>>();
      const newMarks = new Map<number, Set<number>>();
      for (const index of item.deleted) {
        const ref = oldWords[index];
        oldMarks.set(ref.sentence, (oldMarks.get(ref.sentence) ?? new Set<number>()).add(ref.word));
      }
      for (const index of item.inserted) {
        const ref = newWords[index];
        newMarks.set(ref.sentence, (newMarks.get(ref.sentence) ?? new Set<number>()).add(ref.word));
      }
      const beforeSide = item.a.size ? side(before, [...item.a].sort((x, y) => x - y), oldMarks) : null;
      const afterSide = item.b.size ? side(after, [...item.b].sort((x, y) => x - y), newMarks) : null;
      changes.push({
        kind: !beforeSide ? "added" : !afterSide ? "removed" : "changed",
        before: beforeSide,
        after: afterSide,
        conditions: sprayConditions(`${beforeSide?.text ?? ""} ${afterSide?.text ?? ""}`),
      });
    }
  }

  // A sentence removed in one place and added unchanged in another moved; it did not change.
  const keyOf = (change: TextChange, which: "before" | "after") => wordKey(change[which]?.text ?? "");
  const removedByKey = new Map<string, number[]>();
  changes.forEach((change, index) => {
    if (change.kind !== "removed") return;
    const key = keyOf(change, "before");
    removedByKey.set(key, [...(removedByKey.get(key) ?? []), index]);
  });
  const movedIndexes = new Set<number>();
  changes.forEach((change, index) => {
    if (change.kind !== "added") return;
    const match = removedByKey.get(keyOf(change, "after"))?.find((candidate) => !movedIndexes.has(candidate));
    if (match === undefined) return;
    movedIndexes.add(match);
    movedIndexes.add(index);
  });
  const kept = changes.filter((_, index) => !movedIndexes.has(index));

  // Spray conditions first, then in page order of the newer version.
  const position = (change: TextChange) => change.after?.page ?? change.before?.page ?? 0;
  kept.sort((x, y) => Number(y.conditions.length > 0) - Number(x.conditions.length > 0) || position(x) - position(y));

  return {
    changes: kept,
    sentences: { from: before.length, to: after.length },
    moved: movedIndexes.size / 2,
    formatting,
    blankPages: blank,
    unreadable: null,
    tooLong: false,
  };
}
