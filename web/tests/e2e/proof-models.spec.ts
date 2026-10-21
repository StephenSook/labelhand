import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("the proof page compares every Nemotron model alone on the same cases", async ({ page }) => {
  await page.goto("/proof#model-alone");
  const table = page.locator("[data-model-alone-table]");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("[data-model-row='nvidia/nemotron-3-super-120b-a12b']")).toContainText("30 of 30");
  await expect(table.locator("[data-model-row='nvidia/Nemotron-3-Ultra-550b-a55b']")).toContainText("24 of 30");
  await expect(table.locator("[data-model-row='nvidia/Nemotron-3_5-Lightning']")).toContainText("814 of 1,296 (63%)");
});

test("the proof page leads the model-alone section with the shipped tank and names the first tank", async ({ page }) => {
  const shipped = JSON.parse(await readFile(path.join(process.cwd(), "public/data/model-alone-shipped.json"), "utf8"));
  const m = shipped.pooled.agreement_matrix_model_x_planner;
  const modelGo = m.PERMITTED.PERMITTED + m.PERMITTED.BLOCKED + m.PERMITTED.FIELD_CHECK;
  const missed = shipped.pooled.quote_check.total - shipped.pooled.quote_check.matched;
  expect(shipped.tank_registrations).toEqual(["5481-504", "228-653", "228-659"]);
  await page.goto("/proof#model-alone");
  const section = page.locator("#model-alone");
  await expect(section).toContainText("the three shipped labels (Folex 6 EC, FreeFall SC and Super Boll)");
  await expect(section.locator("[data-model-alone-shipped]")).toContainText(`said go on ${modelGo} hours, none of them blocked`);
  await expect(section.locator("[data-model-alone-shipped]")).toContainText(`${missed} of its cited sentences are not on the page it named`);
  await expect(section).toContainText("On the first tank (Folex 6 EC, Dropp SC, Prep)");
});
