import { describe, expect, test } from "vitest";

import { BULLETINS_LIVE_TWO_URL, bulletinCoordinates } from "@/lib/bulletins";

describe("Bulletins Live! Two pointer", () => {
  test("links EPA's own bulletin app", () => {
    expect(BULLETINS_LIVE_TWO_URL).toBe("https://blt.epa.gov/blt/public");
  });

  test("prints latitude first, the order the map's Location Search reads", () => {
    expect(bulletinCoordinates(31.4, -83.6)).toBe("31.4, -83.6");
    expect(bulletinCoordinates(31.712345678, -83.25)).toBe("31.7123, -83.25");
  });
});
