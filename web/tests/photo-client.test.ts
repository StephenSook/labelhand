import { describe, expect, test } from "vitest";

import { fitWithinLongSide } from "@/lib/photo-client";

describe("photo client sizing", () => {
  test.each([
    [3200, 2400, 1600, 1200],
    [1200, 3200, 600, 1600],
    [800, 600, 800, 600],
    [2000, 2000, 1600, 1600],
  ])("fits %sx%s within the long side", (width, height, expectedWidth, expectedHeight) => {
    expect(fitWithinLongSide(width, height)).toEqual({ width: expectedWidth, height: expectedHeight });
  });

  test("refuses invalid dimensions", () => {
    expect(() => fitWithinLongSide(0, 100)).toThrow(TypeError);
    expect(() => fitWithinLongSide(Number.NaN, 100)).toThrow(TypeError);
  });
});
