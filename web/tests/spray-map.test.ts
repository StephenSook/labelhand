import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Citation, EvaluatedHour } from "@/engine";
import { dayHour, mapSummary, pointStatus, statusHeadline, statusOrder, windowText } from "@/lib/spray-map";

const START = Date.parse("2026-10-15T12:00:00Z"); // 8 AM Eastern
const HOUR = 60 * 60 * 1000;

const folex: Citation = { product: "FOLEX 6 EC", rule: "r1", page: 3, quote: "Do not apply below 60 F.", why: "48 F" };

function hours(states: string): EvaluatedHour[] {
  // "P" permitted, "B" blocked by the Folex clause, "F" field check
  return [...states].map((code, i) => ({
    start: new Date(START + i * HOUR).toISOString(),
    state: code === "P" ? "PERMITTED" : code === "B" ? "BLOCKED" : "FIELD_CHECK",
    temp_f: 70,
    wind: "5 mph",
    pop: 0,
    sun_alt: 30,
    blocked: code === "B" ? [folex] : [],
    checks: code === "F" ? [{ ...folex, rule: "r2", quote: "Check wind at the field." }] : [],
    advisories: [],
  }));
}

describe("pointStatus", () => {
  test("open when the map time sits inside a run with a full job left", () => {
    const status = pointStatus(hours("PPPPPBB"), 3, START + 30 * 60 * 1000);
    expect(status.kind).toBe("open");
    if (status.kind === "open") expect(status.hoursLeft).toBe(4);
  });

  test("an open run too short for the rest of the job waits for the next one", () => {
    const status = pointStatus(hours("PPPBBPPPP"), 3, START + 1.5 * HOUR);
    expect(status.kind).toBe("later");
    if (status.kind === "later") {
      expect(status.window.start).toBe(new Date(START + 5 * HOUR).toISOString());
      expect(status.startsInHours).toBe(4);
    }
  });

  test("later names the first run that fits the job", () => {
    const status = pointStatus(hours("BBPPBPPPPB"), 3, START);
    expect(status.kind).toBe("later");
    if (status.kind === "later") {
      expect(status.window.length).toBe(4);
      expect(status.startsInHours).toBe(5);
    }
  });

  test("none names the clause that blocks the most hours still ahead", () => {
    const status = pointStatus(hours("PPBBBBFB"), 3, START + 2 * HOUR);
    expect(status.kind).toBe("none");
    if (status.kind === "none") {
      expect(status.hoursChecked).toBe(6);
      expect(status.topClause?.quote).toBe("Do not apply below 60 F.");
      expect(status.topClause?.hourCount).toBe(5);
    }
  });

  test("a run that ended before the map time is not counted", () => {
    expect(pointStatus(hours("PPPPBBBB"), 3, START + 6 * HOUR).kind).toBe("none");
  });
});

describe("ordering and text", () => {
  test("open first, then the soonest later window, then none", () => {
    const open = pointStatus(hours("PPPP"), 3, START);
    const soon = pointStatus(hours("BPPP"), 3, START);
    const late = pointStatus(hours("BBBPPP"), 3, START);
    const none = pointStatus(hours("BBBB"), 3, START);
    const sorted = [none, late, open, soon].sort(statusOrder);
    expect(sorted).toEqual([open, soon, late, none]);
  });

  test("times read in Eastern time", () => {
    expect(dayHour("2026-10-15T18:00:00Z")).toBe("Thu 2 PM");
    expect(windowText({ start: "2026-10-15T18:00:00Z", end: "2026-10-15T23:00:00Z", length: 5 })).toBe("Thu 2 PM to 7 PM");
    expect(windowText({ start: "2026-10-16T02:00:00Z", end: "2026-10-16T06:00:00Z", length: 4 })).toBe("Thu 10 PM to Fri 2 AM");
  });

  test("the summary counts fields and names the map time", () => {
    const statuses = [pointStatus(hours("PPPP"), 3, START), pointStatus(hours("BPPP"), 3, START), pointStatus(hours("BBBB"), 3, START)];
    expect(mapSummary(statuses, 3)).toBe("1 of 3 fields can start a 3-hour job now. 1 more open later in the forecast.");
    expect(mapSummary(statuses.slice(1), 3, "at Thu 2 PM")).toBe("No field can start a 3-hour job at Thu 2 PM. 1 of 2 open later in the forecast.");
    expect(mapSummary(statuses.slice(2), 3)).toBe("No field has a 3-hour job anywhere in the forecast.");
    expect(mapSummary([statuses[0]!, statuses[0]!], 3, "at Thu 10 AM")).toBe("All 2 fields can start a 3-hour job at Thu 10 AM.");
    expect(mapSummary([statuses[0]!, statuses[2]!], 3)).toBe("1 of 2 fields can start a 3-hour job now. The rest have no 3-hour job in the forecast.");
    expect(statusHeadline(statuses[2]!, 3)).toBe("No 3-hour window");
  });
});

describe("county map", () => {
  test("has a shape for every forecast point and fits its frame", () => {
    const root = path.join(process.cwd(), "public/data");
    const map = JSON.parse(readFileSync(path.join(root, "map/south-georgia.json"), "utf8")) as {
      width: number;
      height: number;
      counties: { name: string; point: string | null; label: [number, number] }[];
    };
    const points = JSON.parse(readFileSync(path.join(root, "nws_points_cache.json"), "utf8")) as { name: string }[];
    const mapped = map.counties.filter((county) => county.point).map((county) => county.point).sort();
    expect(mapped).toEqual(points.map((point) => point.name).sort());
    for (const county of map.counties.filter((item) => item.point)) {
      expect(county.label[0]).toBeGreaterThan(0);
      expect(county.label[0]).toBeLessThan(map.width);
      expect(county.label[1]).toBeGreaterThan(0);
      expect(county.label[1]).toBeLessThan(map.height);
    }
  });
});
