import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Both fixtures are real responses recorded from this app's routes on 2026-10-19 (EPA PPLS search,
// then a live Nemotron compile of Axial XL, EPA Reg. 100-1256). Serving them keeps CI off the
// owner's Token Factory credit while the page runs its real stream reader and planner.
const fixtures = path.join(process.cwd(), "tests/fixtures/live");

async function serveRecordedCompile(page: Page) {
  const search = await readFile(path.join(fixtures, "search-axial-xl.json"), "utf8");
  const stream = await readFile(path.join(fixtures, "axial-xl-100-1256.ndjson"), "utf8");
  await page.route("**/api/labels/search?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: search }));
  await page.route("**/api/labels/compile", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: stream }));
}

test("a searched EPA label is compiled into the tank and checked as UNSCORED", async ({ page }) => {
  await serveRecordedCompile(page);
  await page.goto("/app?field=tift&products=none&hours=3&replay=tift");
  await page.locator("#any-label-query").fill("Axial XL");
  await page.getByRole("button", { name: "Search EPA" }).click();
  await page.getByRole("list", { name: "EPA products found" }).getByRole("button", { name: /100-1256/ }).click();

  const chip = page.locator("[data-live-label='100-1256']");
  await expect(chip).toContainText("UNSCORED");
  await expect(chip).toContainText("56 rules kept, 1 rejected by the guards");
  await expect(page).toHaveURL(/live=100-1256/);

  // Reopen the link the page wrote, on the recorded Tift forecast, so the check never waits on NWS.
  await page.goto(`${page.url()}&replay=tift`);
  await expect(page.locator("#next-window")).toContainText("AXIAL XL (UNSCORED)", { timeout: 30_000 });
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
  await page.locator("#rules-in-tank summary").click();
  await expect(page.locator("[data-unscored-group]")).toHaveCount(1);
});

test("a live= link reads the label first, then runs the planner with it in the tank", async ({ page }) => {
  await serveRecordedCompile(page);
  await page.goto("/app?field=tift&products=5481-504&hours=3&replay=tift&live=100-1256");
  await expect(page.locator("#next-window")).toContainText("Folex 6 EC, AXIAL XL (UNSCORED)", { timeout: 30_000 });
  await expect(page.locator("[data-live-label='100-1256']")).toBeVisible();
});

test("removing the last product disables the check", async ({ page }) => {
  await serveRecordedCompile(page);
  await page.goto("/app?field=tift&products=none&hours=3&replay=tift&live=100-1256");
  await expect(page.locator("[data-live-label='100-1256']")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Remove AXIAL XL/ }).click();
  await expect(page.getByRole("button", { name: "Check 156 forecast hours" })).toBeDisabled();
  await expect(page).not.toHaveURL(/live=/);
});
