import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  evaluate,
  filterRules,
  initializeEngine,
  type CompiledLabel,
  type ForecastPeriod,
  type Rule,
} from "@/engine";

const projectRoot = process.cwd();

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(projectRoot, file), "utf8")) as T;
}

describe("Rust WASM adapter", () => {
  test("filters real labels and evaluates all 156 recorded Tift hours", async () => {
    const wasm = await readFile(
      path.join(projectRoot, "src/engine/pkg/labelhand_core_bg.wasm"),
    );
    await initializeEngine(new Uint8Array(wasm).buffer);

    const replay = await readJson<{
      periods: ForecastPeriod[];
    }>("public/data/replay/tift.json");
    const pointCache = await readJson<
      Array<{ name: string; lat: number; lon: number }>
    >("public/data/nws_points_cache.json");
    const tift = pointCache.find((point) => point.name === "tift");
    expect(tift).toBeDefined();

    const registrations = ["5481-504", "264-700", "264-418"];
    const rules: Rule[] = [];
    for (const reg of registrations) {
      const compiled = await readJson<CompiledLabel>(
        `public/data/compiled/${reg}.ship.json`,
      );
      const filtered = await filterRules(compiled, reg);
      expect(filtered.product).toBe(compiled.product);
      expect(filtered.used.length).toBeGreaterThan(0);
      rules.push(...filtered.used);
    }

    const hours = await evaluate(rules, replay.periods, tift!.lat, tift!.lon, 156);

    expect(hours).toHaveLength(156);
    const blockedCitation = hours.flatMap((hour) => hour.blocked).find(Boolean);
    expect(blockedCitation).toBeDefined();
    expect(blockedCitation!.quote.length).toBeGreaterThan(0);
    expect(blockedCitation!.page).not.toBeNull();
    expect(rules.some((rule) => rule.quote === blockedCitation!.quote)).toBe(true);
  });

  // The committed WASM is what Vercel serves. Its bytes differ between a Windows and a Linux build (rustc embeds
  // host source paths in panic messages), so freshness is checked by behaviour: it must reproduce every frozen
  // engine fixture exactly, the same truth the Python kernel and the Rust parity suite are held to.
  test("committed WASM reproduces every frozen engine fixture exactly", async () => {
    const wasm = await readFile(path.join(projectRoot, "src/engine/pkg/labelhand_core_bg.wasm"));
    await initializeEngine(new Uint8Array(wasm).buffer);
    const dir = path.join(projectRoot, "..", "tests", "fixtures", "engine");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThanOrEqual(3); // a parity check that walks nothing must fail
    for (const name of files) {
      const fixture = JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
        rules: Rule[];
        periods: ForecastPeriod[];
        lat: number;
        lon: number;
        hours: number;
        expected: unknown[];
      };
      const hours = await evaluate(fixture.rules, fixture.periods, fixture.lat, fixture.lon, fixture.hours);
      expect(hours, name).toEqual(fixture.expected);
    }
  });
});
