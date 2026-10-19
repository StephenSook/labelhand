import { describe, expect, test } from "vitest";

import { mergeReports, type MergeReport, type MergeRule } from "@/lib/compiler/merge-reports";
import mergeFixtures from "./fixtures/compiler/merge_reports.json";

describe("compiler report merge parity", () => {
  test.each(mergeFixtures)("matches Python bytes for $name", ({ input, expected_serialized }) => {
    const actual = mergeReports(
      input.reports as Array<MergeReport<MergeRule>>,
      input.run_names,
    );
    expect(JSON.stringify(actual)).toBe(expected_serialized);
  });
});
