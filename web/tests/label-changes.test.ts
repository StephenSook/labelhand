import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { evaluate, filterRules, initializeEngine, type CompiledLabel, type ForecastPeriod, type Rule } from "@/engine";
import {
  defaultPair,
  formatAccepted,
  listText,
  orderedPair,
  parseVersionDiff,
  parseVersionList,
  ruleText,
  sortRuleEntries,
  type ChangesData,
  type RuleEntry,
  type RuleView,
} from "@/lib/label-changes";
import changesJson from "../public/data/changes.json";
import versions228653 from "./fixtures/changes/versions-228-653.json";

const changes = changesJson as unknown as ChangesData;
const repoRoot = path.join(process.cwd(), "..");

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(repoRoot, file), "utf8")) as T;
}

describe("version list and comparison answers", () => {
  test("a recorded PPLS list parses, and the page opens on the shipped label against the one before it", () => {
    const list = parseVersionList(200, versions228653);
    expect(list.versions).toHaveLength(8);
    expect(defaultPair(list.versions, "000228-00653-20210514.pdf")).toEqual({ from: "000228-00653-20210127.pdf", to: "000228-00653-20210514.pdf" });
    // Without a shipped label the newest version is compared with the one before it.
    expect(defaultPair(list.versions)).toEqual({ from: "000228-00653-20210127.pdf", to: "000228-00653-20210514.pdf" });
    expect(defaultPair(list.versions.slice(0, 1))).toBeNull();
    // Picked in either order, the older file is the earlier side; the same file twice is no pair.
    expect(orderedPair(list.versions, "000228-00653-20210514.pdf", "000228-00653-20090820.pdf")).toEqual({
      from: "000228-00653-20090820.pdf",
      to: "000228-00653-20210514.pdf",
    });
    expect(orderedPair(list.versions, "000228-00653-20210514.pdf", "000228-00653-20210514.pdf")).toBeNull();
  });

  test("an error answer becomes its own plain sentence, and a malformed answer is refused", () => {
    expect(() => parseVersionList(503, { error: "EPA's label system (PPLS) did not answer for EPA Reg. 228-653." })).toThrow(
      "EPA's label system (PPLS) did not answer for EPA Reg. 228-653.",
    );
    expect(() => parseVersionList(502, null)).toThrow("The label version list returned HTTP 502.");
    expect(() => parseVersionList(200, { reg: "228-653", versions: [{ fileName: "../etc/passwd", accepted: "x", url: "x" }] })).toThrow("not an EPA PPLS label");
    expect(() => parseVersionDiff(200, { reg: "228-653", from: {}, to: {}, diff: { changes: [] } })).toThrow("did not name both PDFs");
  });

  test("a recorded comparison parses with both PDFs' SHA-256", async () => {
    const recorded = await readJson<unknown>("web/tests/fixtures/changes/diff-228-653.json");
    const diff = parseVersionDiff(200, recorded);
    expect(diff.from.sha256).toBe(changes.labels["228-653"].previous.sha256);
    expect(diff.to.sha256).toBe(changes.labels["228-653"].shipped.sha256);
  });
});

describe("plain wording", () => {
  test("dates, lists and rules read as sentences", () => {
    expect(formatAccepted("2021-01-27")).toBe("January 27, 2021");
    expect(listText([1])).toBe("1");
    expect(listText([1, 2])).toBe("1 and 2");
    expect(listText([1, 2, 3])).toBe("1, 2 and 3");
    const wind: RuleView = {
      id: "x", page: 4, param: "wind_speed_mph", op: "gt", value: 10, value2: null, unit: "mph", modality: "MUST_NOT", quote: "q", planner: "acting", spray_condition: true,
    };
    expect(ruleText(wind)).toBe("MUST NOT, wind_speed_mph above 10 mph");
    expect(ruleText({ ...wind, op: "between", value: 60, value2: 65, unit: "F", modality: "ADVISORY" })).toBe("ADVISORY, wind_speed_mph between 60 and 65 F");
    expect(ruleText({ ...wind, op: "none", value: null, unit: null, modality: "MUST" })).toBe("MUST, wind_speed_mph");
  });

  test("label changes come first, then rules the planner acts on", () => {
    const rule = (planner: RuleView["planner"], page: number): RuleView => ({
      id: "x", page, param: "p", op: null, value: null, value2: null, unit: null, modality: "MUST", quote: "q", planner, spray_condition: false,
    });
    const entries: RuleEntry[] = [
      { key: "a", label_changed: false, shipped: rule("not read", 1) },
      { key: "b", label_changed: false, previous: rule("acting", 9) },
      { key: "c", label_changed: true, shipped: rule("not read", 5) },
    ];
    expect(sortRuleEntries(entries).map((entry) => entry.key)).toEqual(["c", "b", "a"]);
  });
});

// The hour counts on the page come from the Python kernel (tools/label_changes.py). The browser's WebAssembly
// planner must count the same hours on the same rules and forecasts, or the page would describe a planner the app
// does not run.
describe("hours that change state, recounted by the WebAssembly planner", () => {
  test("matches the committed counts for every compiled label, forecast and tank", async () => {
    const wasm = await readFile(path.join(process.cwd(), "src/engine/pkg/labelhand_core_bg.wasm"));
    await initializeEngine(new Uint8Array(wasm).buffer);
    const tank = ["5481-504", "228-653", "228-659"];
    const shipped: Record<string, Rule[]> = {};
    for (const reg of tank) shipped[reg] = (await filterRules(await readJson<CompiledLabel>(`data/compiled/${reg}.ship.json`), reg)).used;
    let checked = 0;
    for (const [reg, entry] of Object.entries(changes.labels)) {
      if (!entry.compiled || !entry.hours) continue;
      const previous = (await filterRules(await readJson<CompiledLabel>(`data/compiled/previous/${reg}.ship.json`), reg)).used;
      const others = tank.filter((other) => other !== reg).flatMap((other) => shipped[other]);
      for (const [name, counts] of Object.entries(entry.hours)) {
        const fixture = await readJson<{ periods: ForecastPeriod[]; lat: number; lon: number }>(changes.forecasts[name].file);
        for (const [which, now, before] of [["tank", [...others, ...shipped[reg]], [...others, ...previous]], ["alone", shipped[reg], previous]] as const) {
          const a = await evaluate([...now], fixture.periods, fixture.lat, fixture.lon, 156);
          const b = await evaluate([...before], fixture.periods, fixture.lat, fixture.lon, 156);
          const changed = a.filter((hour, index) => hour.state !== b[index].state).length;
          expect(changed, `${reg} ${name} ${which}`).toBe(counts[which].changed);
          expect(a.length, `${reg} ${name} ${which}`).toBe(counts[which].hours);
          // The clauses cited under one rule set only, per hour, keyed like the exporter (lowercase, word characters).
          const key = (quote: string) => quote.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
          const cited = (hour: (typeof a)[number]) => new Set([...hour.blocked, ...hour.checks].map((citation) => key(citation.quote)));
          const onlyPrevious: Record<string, number> = {};
          a.forEach((hour, index) => {
            const now = cited(hour);
            for (const quote of cited(b[index])) if (!now.has(quote)) onlyPrevious[quote] = (onlyPrevious[quote] ?? 0) + 1;
          });
          expect(onlyPrevious, `${reg} ${name} ${which}`).toEqual(counts[which].hours_citing_only_previous);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(16); // two compiled labels, four forecasts, two tanks: a check that walks nothing fails
  });
});
