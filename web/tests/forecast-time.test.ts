import { describe, expect, test } from "vitest";
import { formatForecastTime } from "@/lib/planner-data";

describe("forecast timestamps", () => {
  test("read in Eastern time, like the windows", () => {
    expect(formatForecastTime("2026-10-05T17:07:01Z")).toBe("Oct 5, 2026, 1:07:01 PM EDT");
  });
});
