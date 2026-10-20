import { describe, expect, test } from "vitest";

import {
  BULLETINS_LIVE_TWO_URL,
  bulletinCheckPath,
  bulletinCoordinates,
  bulletinMonthLabel,
  bulletinMonths,
  canonicalRegistration,
  easternMonth,
  parseBulletinResponse,
} from "@/lib/bulletins";

describe("Bulletins Live! Two pointer", () => {
  test("links EPA's own bulletin app", () => {
    expect(BULLETINS_LIVE_TWO_URL).toBe("https://blt.epa.gov/blt/public");
  });

  test("prints latitude first, the order the map's Location Search reads", () => {
    expect(bulletinCoordinates(31.4, -83.6)).toBe("31.4, -83.6");
    expect(bulletinCoordinates(31.712345678, -83.25)).toBe("31.7123, -83.25");
  });
});

describe("the month the card checks", () => {
  const now = new Date("2026-10-20T21:00:00Z");

  test("is the Eastern calendar month", () => {
    // 03:00 UTC on November 1 is still October 31 in Georgia.
    expect(easternMonth(new Date("2026-11-01T03:00:00Z"))).toBe("2026-10");
    expect(easternMonth(new Date("2026-11-01T05:00:00Z"))).toBe("2026-11");
  });

  test("is the next window's month", () => {
    expect(bulletinMonths("2026-11-02T13:00:00Z", "2026-11-02T20:00:00Z", now)).toEqual({ check: "2026-11", from: "2026-11" });
    expect(bulletinMonths("2026-10-22T13:00:00Z", undefined, now)).toEqual({ check: "2026-10", from: "2026-10" });
  });

  test("is the last month a window touches when the window crosses into the next month", () => {
    // Twelve permitted hours from 11 PM Eastern on October 31 run to 10 AM EST on November 1.
    expect(bulletinMonths("2026-11-01T03:00:00Z", "2026-11-01T15:00:00Z", now)).toEqual({ check: "2026-11", from: "2026-10" });
  });

  test("does not count the instant a window ends as a month it touches", () => {
    // Two permitted hours, 10 PM to midnight Eastern on October 31.
    expect(bulletinMonths("2026-11-01T02:00:00Z", "2026-11-01T04:00:00Z", now)).toEqual({ check: "2026-10", from: "2026-10" });
  });

  test("is this month when there is no window, or when a recorded window has passed", () => {
    expect(bulletinMonths(undefined, undefined, now)).toEqual({ check: "2026-10", from: "2026-10" });
    expect(bulletinMonths("2026-09-15T13:00:00Z", "2026-09-15T20:00:00Z", now)).toEqual({ check: "2026-10", from: "2026-10" });
    expect(bulletinMonths("not a time", undefined, now)).toEqual({ check: "2026-10", from: "2026-10" });
  });

  test("is named the way the card prints it", () => {
    expect(bulletinMonthLabel("2026-11")).toBe("November 2026");
    expect(bulletinMonthLabel("2027-01")).toBe("January 2027");
    expect(bulletinMonthLabel("2026-11", "2026-10")).toBe("October 2026 and November 2026");
  });
});

describe("the bulletin request and answer", () => {
  test("asks for the field point, each tank registration once, and the month", () => {
    expect(bulletinCheckPath(31.4, -83.6, ["5481-504", "264-700", "264-700"], "2026-11"))
      .toBe("/api/bulletins?lat=31.4&lon=-83.6&regs=5481-504%2C264-700&month=2026-11");
  });

  const checked = {
    status: "checked",
    pulas: [{ pula_id: 121, event_name: "Dicamba 2026", effective_date: "2026-02-09T00:00:00.000Z" }],
    limitations: [{ pula_id: 121, code: "DC125", text: "This crop use is located within a PULA.", reg: "264-1241" }],
    checkedAt: "2026-10-20T21:00:00.000Z",
    source: "EPA Bulletins Live! Two data services at blt.epa.gov (informational, not a Bulletin)",
  };

  test("reads a complete checked answer", () => {
    expect(parseBulletinResponse(checked)).toEqual(checked);
  });

  test("passes an unavailable reason through", () => {
    expect(parseBulletinResponse({ status: "unavailable", reason: "EPA did not answer." }))
      .toEqual({ status: "unavailable", reason: "EPA did not answer." });
  });

  test.each([
    ["no object", null],
    ["an unknown status", { ...checked, status: "clear" }],
    ["no limitation list", { ...checked, limitations: undefined }],
    ["no check time", { ...checked, checkedAt: "yesterday" }],
    ["a limitation without text", { ...checked, limitations: [{ ...checked.limitations[0], text: "" }] }],
    ["a limitation for an SLN number", { ...checked, limitations: [{ ...checked.limitations[0], reg: "GA-120005" }] }],
    ["a PULA without an id", { ...checked, pulas: [{ event_name: "Dicamba 2026", effective_date: null }] }],
  ])("treats %s as unavailable, never as no limits", (_name, payload) => {
    expect(parseBulletinResponse(payload).status).toBe("unavailable");
  });

  test("a limitation for a product that is not in the tank is not shown as this tank's", () => {
    expect(parseBulletinResponse(checked, ["264-1241"]).status).toBe("checked");
    expect(parseBulletinResponse(checked, ["000264-01241"]).status).toBe("checked");
    expect(parseBulletinResponse(checked, ["264-700", "264-418"])).toEqual({
      status: "unavailable",
      reason: expect.stringContaining("264-1241"),
    });
  });
});

describe("registration numbers", () => {
  test("are written the way BLT stores them", () => {
    expect(canonicalRegistration("000264-00700")).toBe("264-700");
    expect(canonicalRegistration("61842-55")).toBe("61842-55");
    expect(canonicalRegistration("GA-120005")).toBe("GA-120005");
  });
});
