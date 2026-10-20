import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { evaluate, filterRules, initializeEngine, type CompiledLabel, type Rule } from "@/engine";
import type { PlannerHour } from "@/lib/planner-data";
import { parseSeasonDay, parseSeasonIndex, type SeasonDay, type SeasonIssuance } from "@/lib/season";
import {
  bestScored,
  earlierIssuances,
  easternHourOf,
  isMorningOf,
  morningIssuance,
  scoreIssuance,
  toReplay,
  windowStability,
  type Evaluate,
} from "@/lib/season-replay";

const projectRoot = path.resolve(__dirname, "..");

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(projectRoot, relative), "utf8")) as T;
}

function issuance(fetchedUtc: string, firstStart: string, hours = 6): SeasonIssuance {
  return {
    fetched_utc: fetchedUtc,
    first_start: firstStart,
    hours,
    is_daytime: Array.from({ length: hours }, () => true),
    temperature_f: Array.from({ length: hours }, () => 75),
    wind_mph: Array.from({ length: hours }, () => 5),
    pop: Array.from({ length: hours }, () => 0),
  };
}

// A stand-in planner: every hour whose start is in `permitted` is PERMITTED, the rest BLOCKED.
function fakeEvaluate(permittedByIssuance: Map<string, Set<string>>, order: string[]): Evaluate {
  let call = 0;
  return async (_rules, periods) => {
    const key = order[call];
    call += 1;
    const permitted = permittedByIssuance.get(key) ?? new Set<string>();
    return periods.map((period) => ({
      start: period.startTime,
      state: permitted.has(new Date(period.startTime).toISOString()) ? "PERMITTED" : "BLOCKED",
    })) as unknown as PlannerHour[];
  };
}

describe("season replay helpers", () => {
  test("picks the first forecast issued at or after 7 AM Eastern", () => {
    const day: SeasonDay = {
      point: "tift",
      day: "2026-10-07",
      source: "test",
      issuances: [
        issuance("2026-10-07T12:07:00+00:00", "2026-10-07T08:00:00-04:00"),
        issuance("2026-10-07T10:07:00+00:00", "2026-10-07T06:00:00-04:00"),
        issuance("2026-10-07T11:07:00+00:00", "2026-10-07T07:00:00-04:00"),
      ],
    };
    expect(easternHourOf("2026-10-07T11:07:00+00:00")).toBe(7);
    expect(morningIssuance(day).fetched_utc).toBe("2026-10-07T11:07:00+00:00");
  });

  test("falls back to the last forecast of a day that ends before 7 AM Eastern", () => {
    const day: SeasonDay = {
      point: "tift",
      day: "2026-10-05",
      source: "test",
      issuances: [
        issuance("2026-10-05T01:19:00+00:00", "2026-10-04T21:00:00-04:00"),
        issuance("2026-10-05T02:07:00+00:00", "2026-10-04T22:00:00-04:00"),
      ],
    };
    expect(morningIssuance(day).fetched_utc).toBe("2026-10-05T02:07:00+00:00");
    // Review 2026-10-19: Tift's Oct 16 file ends at 4:07 AM Eastern; the fallback must be flagged.
    expect(isMorningOf(day.day, morningIssuance(day).fetched_utc)).toBe(false);
    expect(isMorningOf("2026-10-16", "2026-10-16T08:07:01Z")).toBe(false);
    expect(isMorningOf("2026-10-16", "2026-10-16T11:07:01Z")).toBe(true);
  });

  test("ranks fitting windows first, then permitted hours, then the earlier morning", () => {
    const window = { start: "a", end: "b", length: 4 };
    const best = bestScored([
      { day: "2026-10-06", fetchedUtc: "2026-10-06T11:07:00Z", morning: true, permittedHours: 40, windows: [] },
      { day: "2026-10-08", fetchedUtc: "2026-10-08T11:07:00Z", morning: true, permittedHours: 12, windows: [window] },
      { day: "2026-10-07", fetchedUtc: "2026-10-07T11:07:00Z", morning: true, permittedHours: 12, windows: [window] },
    ]);
    expect(best?.day).toBe("2026-10-07");
    expect(bestScored([])).toBeUndefined();
  });

  test("stability counts earlier forecasts that permitted every hour and skips ones that end before the window", async () => {
    const window = { start: "2026-10-07T18:00:00.000Z", end: "2026-10-07T20:00:00.000Z", length: 2 };
    const both = new Set(["2026-10-07T18:00:00.000Z", "2026-10-07T19:00:00.000Z"]);
    const one = new Set(["2026-10-07T18:00:00.000Z"]);
    const earlier = [
      issuance("e1", "2026-10-07T13:00:00-04:00", 4),
      issuance("e2", "2026-10-07T12:00:00-04:00", 4),
      issuance("e3", "2026-10-07T10:00:00-04:00", 2),
    ];
    const evaluateFake = fakeEvaluate(new Map([["e1", both], ["e2", one], ["e3", both]]), ["e1", "e2", "e3"]);
    expect(await windowStability(window, earlier, [], 31.4, -83.6, evaluateFake)).toEqual({ held: 1, compared: 2 });
  });

  test("earlier issuances are newest first, strictly before the replayed one, across a day boundary", async () => {
    const index = parseSeasonIndex({
      generated_utc: "2026-10-08T00:00:00Z",
      recorded_span: { first: "2026-10-06T00:00:00Z", last: "2026-10-07T23:00:00Z" },
      points: { tift: { days: ["2026-10-06", "2026-10-07"], issuances: 4 } },
    });
    const days: Record<string, SeasonDay> = {
      "2026-10-06": { point: "tift", day: "2026-10-06", source: "t", issuances: [issuance("2026-10-06T22:07:00Z", "2026-10-06T19:00:00-04:00"), issuance("2026-10-06T23:07:00Z", "2026-10-06T20:00:00-04:00")] },
      "2026-10-07": { point: "tift", day: "2026-10-07", source: "t", issuances: [issuance("2026-10-07T00:07:00Z", "2026-10-06T21:00:00-04:00"), issuance("2026-10-07T01:07:00Z", "2026-10-06T22:00:00-04:00")] },
    };
    const loaded: string[] = [];
    const found = await earlierIssuances("tift", index, "2026-10-07T01:07:00Z", 3, async (_point, day) => {
      loaded.push(day);
      return days[day];
    });
    expect(found.map((item) => item.fetched_utc)).toEqual(["2026-10-07T00:07:00Z", "2026-10-06T23:07:00Z", "2026-10-06T22:07:00Z"]);
    expect(loaded).toEqual(["2026-10-07", "2026-10-06"]);
  });
});

describe("season replay on the committed recording and the committed WASM planner", () => {
  test("a replayed morning gives the planner the same hours as the recorded issuance", async () => {
    const wasm = await readFile(path.join(projectRoot, "src/engine/pkg/labelhand_core_bg.wasm"));
    await initializeEngine(new Uint8Array(wasm).buffer);
    const rules: Rule[] = [];
    for (const reg of ["5481-504", "228-653", "228-659"]) {
      const compiled = await readJson<CompiledLabel>(`public/data/compiled/${reg}.ship.json`);
      rules.push(...(await filterRules(compiled, reg)).used);
    }
    const index = parseSeasonIndex(await readJson<unknown>("public/data/season/index.json"));
    const scored = [];
    for (const day of index.points.tift.days) {
      const recorded = parseSeasonDay(await readJson<unknown>(`public/data/season/tift/${day}.json`));
      const morning = morningIssuance(recorded);
      const result = await scoreIssuance(day, morning, rules, 31.4, -83.6, 4);
      const replay = toReplay(morning);
      const direct = await evaluate(rules, replay.periods, 31.4, -83.6, Math.min(156, replay.periods.length)) as PlannerHour[];
      expect(result.permittedHours).toBe(direct.filter((hour) => hour.state === "PERMITTED").length);
      scored.push(result);
    }
    expect(scored).toHaveLength(index.points.tift.days.length);
    const best = bestScored(scored);
    expect(best).toBeDefined();
    // Recorded fact, checked against this data: some October morning at Tift had a 4-hour window.
    expect(best!.windows.length).toBeGreaterThan(0);
  });
});
