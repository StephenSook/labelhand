import { describe, expect, test } from "vitest";

import { guard, norm, quoteNumbers, restoreUnits, type GuardRule } from "@/lib/compiler/guards";
import guardFixtures from "./fixtures/compiler/guards.json";
import numberFixtures from "./fixtures/compiler/quote_numbers.json";
import restoreFixtures from "./fixtures/compiler/restore_units.json";

describe("compiler guard parity", () => {
  test.each(guardFixtures)("matches Python for $name", ({ input, expected }) => {
    expect(guard(input.rule as GuardRule, norm(input.page_text))).toBe(expected);
  });

  test("covers every Python rejection reason", () => {
    const reasons = new Set(
      guardFixtures
        .map(({ expected }) => expected?.split(":")[0])
        .filter((reason): reason is string => reason !== undefined),
    );
    expect(reasons).toEqual(new Set([
      "QUOTE_TOO_SHORT",
      "QUOTE_SPLICED",
      "QUOTE_NOT_IN_PAGE",
      "NUMBER_NOT_IN_QUOTE",
      "UNREADABLE_GLYPH",
    ]));
  });

  test.each(numberFixtures)("extracts Python quote numbers for $name", ({ input, expected }) => {
    expect(quoteNumbers(norm(input))).toEqual(expected);
  });

  test.each(restoreFixtures)("restores Python units for $name", ({ input, expected }) => {
    expect(restoreUnits(input as GuardRule)).toEqual(expected);
  });
});
