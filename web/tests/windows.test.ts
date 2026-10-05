import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import {
  evaluate,
  filterRules,
  initializeEngine,
  type CompiledLabel,
  type EvaluatedHour,
  type ForecastPeriod,
  type Rule,
} from "@/engine";
import { forecastPermittedWindows } from "@/lib/windows";

const projectRoot = process.cwd();

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(projectRoot, file), "utf8")) as T;
}

function hour(start: string, state: EvaluatedHour["state"]): EvaluatedHour {
  return {
    start,
    state,
    temp_f: null,
    wind: null,
    pop: null,
    sun_alt: 0,
    blocked: [],
    checks: [],
    advisories: [],
  };
}

describe("forecastPermittedWindows", () => {
  beforeAll(async () => {
    const wasm = await readFile(
      path.join(projectRoot, "src/engine/pkg/labelhand_core_bg.wasm"),
    );
    await initializeEngine(new Uint8Array(wasm).buffer);
  });

  test("keeps maximal permitted runs and breaks at a missing hour", () => {
    const hours = [
      hour("2026-10-05T09:00:00-04:00", "PERMITTED"),
      hour("2026-10-05T10:00:00-04:00", "PERMITTED"),
      hour("2026-10-05T11:00:00-04:00", "PERMITTED"),
      hour("2026-10-05T12:00:00-04:00", "BLOCKED"),
      hour("2026-10-05T13:00:00-04:00", "PERMITTED"),
      hour("2026-10-05T15:00:00-04:00", "PERMITTED"),
    ];

    expect(forecastPermittedWindows(hours)).toEqual([
      {
        start: "2026-10-05T09:00:00-04:00",
        end: "2026-10-05T16:00:00.000Z",
        length: 3,
      },
    ]);
  });

  test("matches independently derived run lengths on all replay forecasts", async () => {
    const pointCache = await readJson<
      Array<{ name: string; lat: number; lon: number }>
    >("public/data/nws_points_cache.json");

    const rules: Rule[] = [];
    for (const reg of ["5481-504", "264-700", "264-418"]) {
      const compiled = await readJson<CompiledLabel>(
        `public/data/compiled/${reg}.union.typed.v3.json`,
      );
      rules.push(...(await filterRules(compiled, reg)).used);
    }

    for (const name of ["tift", "worth", "colquitt"]) {
      const point = pointCache.find((candidate) => candidate.name === name);
      expect(point).toBeDefined();
      const replay = await readJson<{ periods: ForecastPeriod[] }>(
        `public/data/replay/${name}.json`,
      );
      const hours = await evaluate(
        rules,
        replay.periods,
        point!.lat,
        point!.lon,
        156,
      );

      const independentlyDerivedLengths = hours
        .map((item) => (item.state === "PERMITTED" ? "p" : "|"))
        .join("")
        .split("|")
        .map((run) => run.length)
        .filter((length) => length >= 3);
      const windows = forecastPermittedWindows(hours);

      expect(windows.map((window) => window.length), name).toEqual(
        independentlyDerivedLengths,
      );
      expect(windows, name).toHaveLength(independentlyDerivedLengths.length);
    }
  });

  test("rejects a non-positive job length", () => {
    expect(() => forecastPermittedWindows([], 0)).toThrow(RangeError);
  });
});
