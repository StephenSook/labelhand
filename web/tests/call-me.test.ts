import { describe, expect, test } from "vitest";
import { usE164 } from "@/ui/planner/CallMe";

describe("usE164", () => {
  test("accepts US numbers typed the usual ways", () => {
    for (const typed of ["(229) 555-0100", "229.555.0100", "229 555 0100", "+1 229 555 0100", "12295550100"]) {
      expect(usE164(typed)).toBe("+12295550100");
    }
  });

  test("refuses numbers a US carrier cannot route", () => {
    for (const typed of ["", "555-0100", "(129) 555-0100", "(229) 155-0100", "+44 20 7946 0958", "229555010000"]) {
      expect(usE164(typed)).toBeNull();
    }
  });
});
