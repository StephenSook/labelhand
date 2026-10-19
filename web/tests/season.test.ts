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
  fetchMergedSeasonIndex,
  fetchSeasonDay,
  issuanceToPeriods,
  mergeSeasonIndexes,
  parseSeasonDay,
  parseSeasonIndex,
  SeasonNotRecordedError,
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

  test("merges only remote days after each committed point boundary", () => {
    const committed = parseSeasonIndex({
      generated_utc: "2026-10-19T18:07:01Z",
      recorded_span: { first: "2026-10-05T01:19:36Z", last: "2026-10-19T18:07:01Z" },
      points: { tift: { days: ["2026-10-18", "2026-10-19"], issuances: 40 } },
    });
    const remote = parseSeasonIndex({
      generated_utc: "2026-10-21T12:23:00Z",
      recorded_span: { first: "2026-10-05T01:19:36Z", last: "2026-10-21T12:23:00Z" },
      points: { tift: { days: ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"], issuances: 82 } },
    });

    expect(mergeSeasonIndexes(committed, remote)).toEqual({
      generated_utc: "2026-10-21T12:23:00Z",
      recorded_span: { first: "2026-10-05T01:19:36Z", last: "2026-10-21T12:23:00Z" },
      points: { tift: { days: ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"], issuances: 82 } },
    });
  });

  test("loads the static season index and day when the API route is unavailable", async () => {
    const committed = {
      generated_utc: "2026-10-19T18:07:01Z",
      recorded_span: { first: "2026-10-05T01:19:36Z", last: "2026-10-19T18:07:01Z" },
      points: { tift: { days: ["2026-10-05"], issuances: 24 } },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(committed)))
      .mockResolvedValueOnce(new Response("not configured", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleDay())));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMergedSeasonIndex()).resolves.toEqual(committed);
    await expect(fetchSeasonDay("tift", "2026-10-05")).resolves.toEqual(sampleDay());
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/data/season/index.json",
      "/api/season/index.json",
      "/data/season/tift/2026-10-05.json",
    ]);
  });

  test("surfaces live index storage failures", async () => {
    const committed = {
      generated_utc: "2026-10-19T18:07:01Z",
      recorded_span: { first: "2026-10-05T01:19:36Z", last: "2026-10-19T18:07:01Z" },
      points: { tift: { days: ["2026-10-05"], issuances: 24 } },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(committed)))
      .mockResolvedValueOnce(new Response("storage failed", { status: 502, statusText: "Bad Gateway" })));

    await expect(fetchMergedSeasonIndex()).rejects.toThrow(/HTTP 502/);
  });

  test("surfaces malformed live indexes", async () => {
    const committed = {
      generated_utc: "2026-10-19T18:07:01Z",
      recorded_span: { first: "2026-10-05T01:19:36Z", last: "2026-10-19T18:07:01Z" },
      points: { tift: { days: ["2026-10-05"], issuances: 24 } },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(committed)))
      .mockResolvedValueOnce(new Response('{"broken":true}')));

    await expect(fetchMergedSeasonIndex()).rejects.toThrow(/recorded_span/);
  });

  test("prefers the API for a newer day", async () => {
    const live = sampleDay();
    live.day = "2099-01-01";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(live)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSeasonDay("tift", "2099-01-01")).resolves.toEqual(live);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/season/tift/2099-01-01.json",
      { cache: "no-store" },
    );
  });

  test("falls back to a committed file when the newer-day API is unavailable", async () => {
    const fallback = sampleDay();
    fallback.day = "2099-01-01";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fallback)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSeasonDay("tift", "2099-01-01")).resolves.toEqual(fallback);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/season/tift/2099-01-01.json",
      "/data/season/tift/2099-01-01.json",
    ]);
  });

  test("does not hide a newer-day storage failure behind static data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("storage failed", {
      status: 502,
      statusText: "Bad Gateway",
    })));

    await expect(fetchSeasonDay("tift", "2099-01-01")).rejects.toThrow(/HTTP 502/);
  });

  test("does not label an unavailable live source as not recorded", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not configured", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(new Response("missing", { status: 404, statusText: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSeasonDay("tift", "2099-01-01")).rejects.toThrow(/HTTP 503/);
  });

  test("turns a missing live and static day into not recorded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" })));
    await expect(fetchSeasonDay("tift", "2099-01-01")).rejects.toBeInstanceOf(SeasonNotRecordedError);
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
