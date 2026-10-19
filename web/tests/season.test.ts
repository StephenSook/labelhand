import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  evaluate,
  filterRules,
  initializeEngine,
  type CompiledLabel,
  type ForecastPeriod,
  type Rule,
} from "@/engine";
import {
  fetchSeasonDay,
  issuanceToPeriods,
  parseSeasonDay,
  parseSeasonIndex,
  type SeasonDay,
} from "@/lib/season";

const projectRoot = process.cwd();

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(projectRoot, file), "utf8")) as T;
}

function sampleDay(): SeasonDay {
  return {
    point: "tift",
    day: "2026-10-05",
    source: "test fixture",
    issuances: [
      {
        fetched_utc: "2026-10-05T01:00:00+00:00",
        first_start: "2026-10-04T21:00:00-04:00",
        hours: 2,
        is_daytime: [false, false],
        temperature_f: [72, 71],
        wind_mph: [5, null],
        wind_raw: [null, "5 to 10 mph"],
        pop: [10, null],
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("season data parser", () => {
  test("parses the committed index shape", () => {
    expect(parseSeasonIndex({
      generated_utc: "2026-10-19T18:07:01+00:00",
      recorded_span: {
        first: "2026-10-05T01:19:36+00:00",
        last: "2026-10-19T18:07:01+00:00",
      },
      points: { tift: { days: ["2026-10-05"], issuances: 24 } },
    }).points.tift.issuances).toBe(24);
  });

  test("rejects malformed index and mismatched columns", () => {
    expect(() => parseSeasonIndex({ points: {} })).toThrow(/recorded_span/);
    const malformed = sampleDay();
    malformed.issuances[0].pop = [10];
    expect(() => parseSeasonDay(malformed)).toThrow(/pop has 1 values, expected 2/);
  });

  test("rebuilds offsets and raw winds without guessing", () => {
    const issuance = parseSeasonDay(sampleDay()).issuances[0];
    expect(issuanceToPeriods(issuance)).toEqual([
      {
        startTime: "2026-10-04T21:00:00-04:00",
        isDaytime: false,
        temperature: 72,
        windSpeed: "5 mph",
        probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: 10 },
      },
      {
        startTime: "2026-10-04T22:00:00-04:00",
        isDaytime: false,
        temperature: 71,
        windSpeed: "5 to 10 mph",
        probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: null },
      },
    ]);
  });

  test("fetches and validates one point day", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sampleDay())));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSeasonDay("tift", "2026-10-05");
    expect(result.point).toBe("tift");
    expect(fetchMock).toHaveBeenCalledWith(
      "/data/season/tift/2026-10-05.json",
      { cache: "no-store" },
    );
  });
});

describe("real season round trip", () => {
  test("preserves real planner periods and committed WASM output", async () => {
    const fixture = await readJson<{
      fetched_utc: string;
      data: { periods: ForecastPeriod[] };
    }>("tests/fixtures/season-hourly-tift.json");
    const day = parseSeasonDay(
      await readJson<unknown>("public/data/season/tift/2026-10-05.json"),
    );
    const issuance = day.issuances.find(
      (candidate) => candidate.fetched_utc === fixture.fetched_utc,
    );
    expect(issuance).toBeDefined();
    const rebuilt = issuanceToPeriods(issuance!).slice(0, fixture.data.periods.length);
    expect(rebuilt).toEqual(fixture.data.periods);

    const wasm = await readFile(path.join(projectRoot, "src/engine/pkg/labelhand_core_bg.wasm"));
    await initializeEngine(new Uint8Array(wasm).buffer);
    const rules: Rule[] = [];
    for (const reg of ["5481-504", "264-700", "264-418"]) {
      const compiled = await readJson<CompiledLabel>(`public/data/compiled/${reg}.ship.json`);
      rules.push(...(await filterRules(compiled, reg)).used);
    }

    const originalOutput = await evaluate(rules, fixture.data.periods, 31.4, -83.6, rebuilt.length);
    const rebuiltOutput = await evaluate(rules, rebuilt, 31.4, -83.6, rebuilt.length);
    expect(rebuiltOutput).toEqual(originalOutput);
  });
});
