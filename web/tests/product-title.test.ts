import { describe, expect, test } from "vitest";

import index from "../public/data/labels/index.json";
import { labelTitle, parseLabelIndex, productTitle } from "@/lib/planner-data";

const labels = parseLabelIndex(index);

describe("one name for each product", () => {
  test("keeps the short name when it is the label's own name", () => {
    expect(labelTitle(labels["5481-504"])).toBe("Folex 6 EC");
    expect(labelTitle(labels["228-653"])).toBe("FreeFall SC");
  });

  test("adds EPA's label name when the brand on the jug differs", () => {
    expect(labelTitle(labels["228-659"])).toBe("Super Boll (ETHEPHON E-AG 6 PLANT GROWTH REGULATOR)");
  });

  test("finds the label from a citation's product name, and leaves an unknown name alone", () => {
    expect(productTitle(labels, "ETHEPHON E-AG 6 PLANT GROWTH REGULATOR")).toBe("Super Boll (ETHEPHON E-AG 6 PLANT GROWTH REGULATOR)");
    expect(productTitle(labels, "AXIAL XL")).toBe("AXIAL XL");
    expect(productTitle(null, "AXIAL XL")).toBe("AXIAL XL");
  });

  test("a live label whose short name is its product name stays as it is", () => {
    expect(labelTitle({ product: "AXIAL XL", shortName: "AXIAL XL" })).toBe("AXIAL XL");
  });
});
