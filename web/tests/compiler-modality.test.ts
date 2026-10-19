import { describe, expect, test } from "vitest";

import {
  applyFloor,
  brandOf,
  floorOf,
  inAdvisorySection,
  type ModalityRule,
} from "@/lib/compiler/modality";
import advisoryFixtures from "./fixtures/compiler/in_advisory_section.json";
import floorFixtures from "./fixtures/compiler/floor_of.json";

describe("compiler modality parity", () => {
  test.each(floorFixtures)("matches Python floor_of for $name", ({ input, expected }) => {
    expect(floorOf(input.quote, input.brand)).toBe(expected);
  });

  test.each(advisoryFixtures)("matches Python in_advisory_section for $name", ({ input, expected }) => {
    expect(inAdvisorySection(input.pages, input.page_no, input.quote)).toBe(expected);
  });

  test("raises only an advisory planner rule outside an advisory section", () => {
    const fixture = advisoryFixtures.find(({ name }) => name === "folex_outside_advisory");
    expect(fixture).toBeDefined();
    const rule: ModalityRule = {
      id: "5481-504-p10-10",
      page: 1,
      param: "night_temperature_f",
      modality: "ADVISORY",
      quote: fixture!.input.quote,
    };
    expect(applyFloor(rule, fixture!.input.pages, "folex")).toMatchObject({
      modality: "MUST",
      modality_model: "ADVISORY",
      modality_floor: expect.stringContaining("PR Notice 2000-5"),
    });
    expect(applyFloor({ ...rule, modality: "MUST" }, fixture!.input.pages, "folex").modality).toBe("MUST");
    expect(applyFloor({ ...rule, param: "rate_per_acre" }, fixture!.input.pages, "folex").modality).toBe("ADVISORY");
  });

  test("extracts the first product word as the brand", () => {
    expect(brandOf("FOLEX 6 EC")).toBe("folex");
    expect(brandOf(" ")).toBeNull();
  });
});
