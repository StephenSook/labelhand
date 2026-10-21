import { describe, expect, test } from "vitest";

import { align, diffLabelText, sentences, sprayConditions, wordKey, type ChangeSide } from "@/lib/label-diff";

const WIND = "Do not apply when wind speeds exceed 10 mph at the application site.";

function marked(side: ChangeSide | null): string[] {
  return side ? side.marks.map(([start, end]) => side.text.slice(start, end)) : [];
}

describe("label sentences", () => {
  test("end at sentence punctuation, not after a.i. or fl., and start again at a bullet", () => {
    const found = sentences(["Use 4.0 fl oz/A (0.125 lb a.i./A) with oil. Wait 7 days. • Keep out of water • Rinse well"]);
    expect(found.map((s) => s.text)).toEqual([
      "Use 4.0 fl oz/A (0.125 lb a.i./A) with oil.",
      "Wait 7 days.",
      "• Keep out of water",
      "• Rinse well",
    ]);
    expect(found.every((s) => s.page === 1)).toBe(true);
  });

  test("carry the page they are printed on and drop page numbers and rules", () => {
    const found = sentences(["First page sentence.", "12", "Third page sentence."]);
    expect(found.map((s) => [s.page, s.text])).toEqual([[1, "First page sentence."], [3, "Third page sentence."]]);
  });

  test("compare words on letters and digits only", () => {
    expect(wordKey("“Accepted”,")).toBe("accepted");
    expect(wordKey("ﬁeld")).toBe("field");
  });
});

describe("label text diff", () => {
  test("two identical labels have no changes", () => {
    const pages = [WIND, "Do not apply during temperature inversions."];
    expect(diffLabelText(pages, pages)).toMatchObject({ changes: [], moved: 0, formatting: 0 });
  });

  test("a moved line break, a comma, a curly quote, a split word or a lost period is not a change", () => {
    const before = ["Do not use a defoliant unless sufficient mature unopened bolls are present.\nFind so meone to \"explain\" it. Wait 7 days. Then spray."];
    const after = ["Do not use a defoliant unless sufficient mature, unopened bolls\nare present. Find someone to “explain” it. Wait 7 days then spray."];
    const diff = diffLabelText(before, after);
    expect(diff.changes).toEqual([]);
    expect(diff.formatting).toBe(1); // the two sentences that became one
  });

  test("a new wind limit is one changed sentence, marked on the number, with its pages and conditions", () => {
    const diff = diffLabelText(
      ["Read the label.", `Keep out of reach. ${WIND}`],
      ["Read the label.", "Keep out of reach.", `Spray only on calm days. ${WIND.replace("10 mph", "15 mph")}`],
    );
    expect(diff.changes).toHaveLength(2);
    const [wind, added] = diff.changes;
    expect(wind.kind).toBe("changed");
    expect(wind.conditions).toEqual(["wind"]);
    expect(marked(wind.before)).toEqual(["10"]);
    expect(marked(wind.after)).toEqual(["15"]);
    expect(wind.before?.text).toBe(WIND);
    expect([wind.before?.page, wind.after?.page]).toEqual([2, 3]);
    expect(added).toMatchObject({ kind: "added", before: null, after: { page: 3, text: "Spray only on calm days." } });
  });

  test("a sentence the new label drops is removed, and words added inside a sentence show the old sentence too", () => {
    const diff = diffLabelText(
      ["Do not apply during temperature inversions. Store in a cool place."],
      ["Do not apply during temperature inversions or when rain is expected within 6 hours."],
    );
    const removed = diff.changes.find((change) => change.kind === "removed");
    expect(removed?.before?.text).toBe("Store in a cool place.");
    const changed = diff.changes.find((change) => change.kind === "changed");
    expect(marked(changed?.after ?? null)).toEqual(["or when rain is expected within 6 hours."]);
    expect(marked(changed?.before ?? null)).toEqual([]); // "inversions." and "inversions" are the same word
    expect(changed?.conditions).toEqual(["rain", "temperature", "inversion"]);
  });

  test("a sentence moved to another page is counted as moved, not listed", () => {
    const diff = diffLabelText(
      ["Wear gloves when mixing.", "Apply in 10 gallons of water per acre. Clean the sprayer after use."],
      ["Apply in 10 gallons of water per acre. Wear gloves when mixing.", "Clean the sprayer after use."],
    );
    expect(diff.changes).toEqual([]);
    expect(diff.moved).toBe(1);
  });

  test("changes that name a spray condition come first, then page order", () => {
    const diff = diffLabelText(
      ["Store below 100 F.", "Shake well.", WIND],
      ["Store below 90 F.", "Shake well before use.", WIND.replace("10 mph", "12 mph")],
    );
    expect(diff.changes.map((change) => change.after?.page)).toEqual([3, 1, 2]);
    expect(diff.changes[0].conditions).toEqual(["wind"]);
  });

  test("pages with no text layer are named, since anything printed only there shows as added", () => {
    const letter = "The Agency has reviewed your application and the amended label is acceptable.";
    const title = "FreeFall SC Cotton Defoliant, for agricultural use only, EPA Reg. No. 228-653.";
    const diff = diffLabelText(["", "  \n ", WIND], [letter, title, WIND]);
    expect(diff.blankPages).toEqual({ from: [1, 2], to: [] });
    expect(diff.changes.map((change) => change.kind)).toEqual(["added", "added"]);
  });
});

describe("spray conditions", () => {
  test("match whole words and their label spellings only", () => {
    expect(sprayConditions("Do not apply when winds exceed 10 mph or during a temperature inversion.")).toEqual(["wind", "temperature", "inversion"]);
    expect(sprayConditions("Rainfast in 6 hours. Keep a 25-foot buffer. Use coarse droplets.")).toEqual(["rain", "buffer", "droplet size"]);
    expect(sprayConditions("Release height 10 feet; boom height 24 inches.")).toEqual(["release height", "boom height"]);
    expect(sprayConditions("Do not enter during the restricted-entry interval (REI) of 7 days.")).toEqual(["re-entry"]);
    expect(sprayConditions("Re-entry is allowed after the sprays have dried.")).toEqual(["re-entry"]);
    expect(sprayConditions("Open the window. Drain the tank. Harvest the grain.")).toEqual([]);
  });
});

describe("alignment", () => {
  test("keeps the longest common run and reports the rest as removed and added", () => {
    const ops = align(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(ops.filter((op) => op.kind === "equal").length).toBe(3);
    expect(ops.filter((op) => op.kind === "delete").map((op) => op.kind === "delete" && op.a)).toEqual([1]);
    expect(ops.filter((op) => op.kind === "insert").map((op) => op.kind === "insert" && op.b)).toEqual([1, 4]);
  });

  test("does not align a block past its size cap; it is reported whole", () => {
    const ops = align(["a", "b"], ["b", "a"], 1);
    expect(ops.filter((op) => op.kind === "equal")).toEqual([]);
  });
});
