import { describe, expect, test } from "vitest";

import { labelsCoverResult } from "@/lib/run-planner";

describe("results render only with every label they name", () => {
  const shipped = { "264-700": {}, "264-418": {} };

  test("a result whose products all have labels renders", () => {
    expect(labelsCoverResult({ registrations: ["264-700", "264-418"] }, shipped)).toBe(true);
  });

  test("a result that still names a live label the visitor removed does not render", () => {
    // The tank re-check replaces this result on the next tick; until then the page must not
    // ask the spray record for label metadata that is gone, which threw during render.
    expect(labelsCoverResult({ registrations: ["264-700", "100-1256"] }, shipped)).toBe(false);
  });

  test("no labels loaded means nothing renders", () => {
    expect(labelsCoverResult({ registrations: ["264-700"] }, null)).toBe(false);
  });
});
