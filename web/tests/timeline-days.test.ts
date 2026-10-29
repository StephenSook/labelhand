import { describe, expect, test } from "vitest";

import type { PlannerHour } from "@/lib/planner-data";
import { groupByDay } from "@/ui/planner/Timeline";

function hourlyFrom(startIso: string, count: number): PlannerHour[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({ start: new Date(start + i * 3_600_000).toISOString() }) as unknown as PlannerHour);
}

const columns = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

describe("timeline day columns follow the Eastern civil day", () => {
  // 2026-10-31 8 PM EDT through 2026-11-02 1 AM EST. Clocks fall back at 2 AM EDT on November 1.
  const fallBack = groupByDay(hourlyFrom("2026-11-01T00:00:00Z", 31));

  test("the fall-back day has 25 columns and two distinct 1 AM columns", () => {
    expect(fallBack.map((group) => group.columns)).toEqual([24, 25, 24]);
    expect(fallBack[1].hours.map((entry) => entry.column)).toEqual(columns(25));
  });

  test("ordinary partial days keep their local-hour columns", () => {
    expect(fallBack[0].hours.map((entry) => entry.column)).toEqual([20, 21, 22, 23]);
    expect(fallBack[2].hours.map((entry) => entry.column)).toEqual([0, 1]);
  });

  test("a forecast that starts after the clocks fell back still lines up", () => {
    // 07:00Z on November 1 is 2 AM EST, three elapsed hours after midnight EDT.
    const late = groupByDay(hourlyFrom("2026-11-01T07:00:00Z", 22));
    expect(late[0].columns).toBe(25);
    expect(late[0].hours.map((entry) => entry.column)).toEqual(columns(22, 3));
  });

  test("the spring-forward day has 23 columns", () => {
    // 2026-03-08 midnight EST is 05:00Z; clocks spring forward at 2 AM EST.
    const spring = groupByDay(hourlyFrom("2026-03-08T05:00:00Z", 23));
    expect(spring).toHaveLength(1);
    expect(spring[0].columns).toBe(23);
    expect(spring[0].hours.map((entry) => entry.column)).toEqual(columns(23));
  });
});
