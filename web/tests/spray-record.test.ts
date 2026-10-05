import { readFile } from "node:fs/promises";
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
import { buildSprayRecordPdf } from "@/lib/spray-record";
import { forecastPermittedWindows } from "@/lib/windows";

const root = process.cwd();

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, file), "utf8")) as T;
}

describe("spray record PDF", () => {
  test("contains replay product registrations, a real clause, and every required blank", async () => {
    const wasm = await readFile(path.join(root, "src/engine/pkg/labelhand_core_bg.wasm"));
    await initializeEngine(new Uint8Array(wasm).buffer);
    const replay = await readJson<{ periods: ForecastPeriod[] }>("public/data/replay/tift.json");
    const points = await readJson<Array<{ name: string; lat: number; lon: number }>>("public/data/nws_points_cache.json");
    const labels = await readJson<Array<{ reg: string; product: string; accepted: string }>>("public/data/labels/index.json");
    const tift = points.find((point) => point.name === "tift");
    expect(tift).toBeDefined();

    const rules: Rule[] = [];
    for (const reg of ["5481-504", "264-700", "264-418"]) {
      const compiled = await readJson<CompiledLabel>(`public/data/compiled/${reg}.ship.json`);
      rules.push(...(await filterRules(compiled, reg)).used);
    }
    const hours = await evaluate(rules, replay.periods, tift!.lat, tift!.lon, 156);
    const windows = forecastPermittedWindows(hours, 1);
    const window = windows.find((candidate) => hours
      .filter((hour) => Date.parse(hour.start) >= Date.parse(candidate.start) && Date.parse(hour.start) < Date.parse(candidate.end))
      .some((hour) => hour.advisories.length > 0));
    expect(window, "the Tift replay should contain a permitted window with a quoted advisory").toBeDefined();
    const windowHours = hours.filter((hour) => Date.parse(hour.start) >= Date.parse(window!.start) && Date.parse(hour.start) < Date.parse(window!.end));
    const clause = windowHours.flatMap((hour) => hour.advisories)[0];
    expect(clause).toBeDefined();

    const bytes = await buildSprayRecordPdf({
      fieldName: "Tift",
      lat: tift!.lat,
      lon: tift!.lon,
      windowStart: window!.start,
      windowEnd: window!.end,
      source: "RECORDED",
      forecastFetchedAt: "2026-10-05T00:00:00Z",
      weather: { temperature: "75°F", wind: "5 mph", rainChance: "10%", sunAltitude: "22.1°" },
      products: labels.map((label) => ({ ...label, restrictedUse: false })),
      clauses: [{ kind: "ADVISORY", product: clause.product, page: String(clause.page), quote: clause.quote }],
    });

    expect(new TextDecoder("ascii").decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.filter((item): item is typeof item & { str: string } => "str" in item).map((item) => item.str).join(" "));
    }
    const text = pageTexts.join(" ").replace(/\s+/gu, " ");
    for (const reg of ["5481-504", "264-700", "264-418"]) expect(text).toContain(reg);
    expect(text).toContain(clause.quote);
    for (const blank of [
      "Applicator name",
      "Applicator certification number, if applicable",
      "Crop, commodity, stored product, or site",
      "Acres treated",
      "Actual start time",
      "Actual end time",
      "Wind measured at the boom",
    ]) expect(text).toContain(blank);
  });
});
