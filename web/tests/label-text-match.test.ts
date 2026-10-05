import { describe, expect, test } from "vitest";
import { matchingTextItemIndexes } from "@/lib/label-text-match";

describe("matchingTextItemIndexes", () => {
  test("maps a quote split across text-layer items back to every contributing item", () => {
    const items = [
      { str: "Apply only" },
      { str: " when wind" },
      { str: " is below 10 mph." },
    ];
    expect(matchingTextItemIndexes(items, "Apply only when wind is below 10 mph.")).toEqual([0, 1, 2]);
  });

  test("ignores extra whitespace", () => {
    const items = [{ str: "Keep   out" }, { str: " of   water" }];
    expect(matchingTextItemIndexes(items, "Keep out of water")).toEqual([0, 1]);
  });

  test("ignores trademark and replacement glyphs", () => {
    const items = [{ str: "FOLEX®\uFFFD 6 EC" }, { str: " alone" }];
    expect(matchingTextItemIndexes(items, "FOLEX 6 EC alone")).toEqual([0, 1]);
  });

  test("returns no items for a miss", () => {
    expect(matchingTextItemIndexes([{ str: "Wind below 10 mph" }], "Rain-free for six hours")).toEqual([]);
  });
});
