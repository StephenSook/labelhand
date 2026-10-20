import { describe, expect, test } from "vitest";

import type { CompiledLiveLabel } from "@/lib/compiler/pipeline";
import { liveLabelRecord } from "@/ui/planner/Planner";

const compiled = {
  reg: "100-1256",
  product: "AXIAL XL",
  label_accepted: "2022-05-03",
  label_url: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01256-20220503.pdf",
  label_sha256: "a".repeat(64),
  restricted_use: false,
} as CompiledLiveLabel;

describe("a live label in the tank", () => {
  test("keeps the not-rechecked mark from a compile served while EPA did not answer", () => {
    expect(liveLabelRecord({ ...compiled, status_unchecked: true })).toMatchObject({ unscored: true, statusUnchecked: true });
  });

  test("has no mark when EPA confirmed the registration", () => {
    expect(liveLabelRecord(compiled)).not.toHaveProperty("statusUnchecked");
  });
});
