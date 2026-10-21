import { describe, expect, test } from "vitest";

import { plainRanges } from "@/lib/plain-ranges";

describe("ranges in a shown answer", () => {
  test("say to instead of an en dash between times or numbers", () => {
    expect(plainRanges("Wed 1 PM–7 PM and Thu 10 AM – 2 PM")).toBe("Wed 1 PM to 7 PM and Thu 10 AM to 2 PM");
    expect(plainRanges("wind 10–15 mph")).toBe("wind 10 to 15 mph");
  });

  test("leave other dashes and hyphenated ids alone", () => {
    expect(plainRanges("rule 228-659-p6-3, EPA Reg. 5481-504")).toBe("rule 228-659-p6-3, EPA Reg. 5481-504");
    expect(plainRanges("Folex – the tribufos label")).toBe("Folex – the tribufos label");
  });
});
