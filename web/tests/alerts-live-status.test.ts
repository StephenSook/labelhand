import { beforeEach, describe, expect, test, vi } from "vitest";

const getIndexMock = vi.hoisted(() => vi.fn());
const getCachedMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/live-cache", () => ({
  getRegistrationCacheIndexStrict: getIndexMock,
  getCachedLiveLabelStrict: getCachedMock,
}));

import { loadAlertTank } from "@/lib/alerts/planner";
import productFixture from "./fixtures/ppls/product-100-1256.json";

function pplsFetch(item: Record<string, unknown>): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...productFixture, items: [item] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  getIndexMock.mockReset().mockResolvedValue({ sha256: "a".repeat(64), pipelineVersion: "test" });
  getCachedMock.mockReset().mockResolvedValue({ reg: "100-1256", product: "AXIAL XL", accepted: [] });
});

describe("a phone alert on a live label", () => {
  test("is refused once EPA lists the registration as cancelled, before the stored compile is read", async () => {
    // The status fields EPA PPLS returned for Dropp SC, 264-700, on 2026-10-20, on the AXIAL XL fixture.
    const cancelled = { ...productFixture.items[0], product_status: "Inactive", product_status_date: "January 15, 2014", cancel_flag: "Yes", cancellationreason: "Company Request" };
    await expect(loadAlertTank(["100-1256"], { pplsFetch: pplsFetch(cancelled) })).rejects.toThrow(/as cancelled since January 15, 2014/);
    expect(getCachedMock).not.toHaveBeenCalled();
  });

  test("fails, with no call, when EPA does not answer", async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error("PPLS unavailable"));
    await expect(loadAlertTank(["100-1256"], { pplsFetch: down })).rejects.toMatchObject({ name: "PplsError" });
    expect(getCachedMock).not.toHaveBeenCalled();
  });

  test("plans an active registration from its stored compile", async () => {
    const tank = await loadAlertTank(["100-1256"], { pplsFetch: pplsFetch(productFixture.items[0]) });
    expect(tank).toEqual([{ reg: "100-1256", name: "AXIAL XL", rules: [] }]);
  });
});
