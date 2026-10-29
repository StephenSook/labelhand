import { describe, expect, test } from "vitest";

import type { PlannerHour } from "@/lib/planner-data";
import { groupByDay } from "@/ui/planner/Timeline";

// Hourly starts in UTC from 2026-10-31 8 PM EDT through 2026-11-02 1 AM EST. Clocks fall back at
// 2 AM EDT on November 1, so that Eastern day has 25 hours and two of them start at 1 AM.
function hourlyFrom(startIso: string, count: number): PlannerHour[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({ start: new Date(start + i * 3_600_000).toISOString() }) as unknown as PlannerHour);
}

describe("timeline day columns", () => {
  const groups = groupByDay(hourlyFrom("2026-11-01T00:00:00Z", 31));
  const byKey = new Map(groups.map((group) => [group.label, group]));
  const fallBack = groups.find((group) => group.hours.length === 25);

  test("the fall-back day keeps all 25 hours in one row of 25 distinct columns", () => {
    expect(fallBack).toBeDefined();
    expect(fallBack!.columns).toBe(25);
    expect(fallBack!.hours.map((entry) => entry.column)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("an ordinary partial day stays on the 24-column grid at its local hours", () => {
    const evening = groups[0];
    expect(evening.columns).toBe(24);
    expect(evening.hours.map((entry) => entry.column)).toEqual([20, 21, 22, 23]);
    const next = groups.at(-1)!;
    expect(next.columns).toBe(24);
    expect(next.hours.map((entry) => entry.column)).toEqual([0, 1]);
    expect(byKey.size).toBe(3);
  });
});
