import { expect, test } from "@playwright/test";

test("the proof page compares every Nemotron model alone on the same cases", async ({ page }) => {
  await page.goto("/proof#model-alone");
  const table = page.locator("[data-model-alone-table]");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("[data-model-row='nvidia/nemotron-3-super-120b-a12b']")).toContainText("30 of 30");
  await expect(table.locator("[data-model-row='nvidia/Nemotron-3-Ultra-550b-a55b']")).toContainText("24 of 30");
  await expect(table.locator("[data-model-row='nvidia/Nemotron-3_5-Lightning']")).toContainText("814 of 1,296 (63%)");
});
