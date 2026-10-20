import { readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Recorded mornings come from the committed season files, so these runs are the same everywhere.
const recordedPath = "/map?mode=recorded&day=2026-10-15&hours=3";

async function waitForMap(page: Page) {
  await expect(page.locator("svg[data-map]")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

test("a recorded morning colors all ten counties and lists them soonest first", async ({ page }) => {
  await page.goto(recordedPath);
  await waitForMap(page);
  await expect(page.locator("a[data-county]")).toHaveCount(10);
  await expect(page.locator("[data-map-list] > li")).toHaveCount(10);
  await expect(page.locator("#map-summary")).toHaveText("No field can start a 3-hour job now. 10 of 10 open later in the forecast.");
  await expect(page.locator("a[data-county][data-status=later]")).toHaveCount(10);
  await expect(page.locator("[data-map-source]")).toContainText("Thu, Oct 15");
  await expect(page.locator("[data-row=tift]")).toContainText("Thu 10 AM to 6 PM, 8 hours long");
});

test("moving the map time opens the counties whose window has started", async ({ page }) => {
  await page.goto(recordedPath);
  await waitForMap(page);
  await page.locator("#map-ahead").fill("3");
  await expect(page.locator("[data-map-time]")).toContainText("3 hours later");
  await expect(page.locator("#map-summary")).toContainText("All 10 fields can start a 3-hour job at Thu 10 AM");
  await expect(page.locator("a[data-county][data-status=open]")).toHaveCount(10);
  await expect(page).toHaveURL(/ahead=3/);
});

test("a county opens the planner on the same recorded forecast", async ({ page }) => {
  await page.goto(recordedPath);
  await waitForMap(page);
  const href = await page.locator("a[data-county=worth]").getAttribute("href");
  expect(href).toMatch(/^\/app\?field=worth&products=5481-504%2C264-700%2C264-418&hours=3&issued=2026-10-15T/);
  await page.goto(href!);
  await expect(page.locator("[data-forecast-source]")).toHaveAttribute("data-forecast-source", "RECORDED", { timeout: 30_000 });
});

test("a live forecast with no window offers the latest recorded morning that had one", async ({ page }) => {
  // Every point gets a recorded forecast moved to start this hour, with every hour at 40 F, below
  // the temperature floor in the default tank, so no hour ahead is permitted.
  const replay = JSON.parse(await readFile(path.join(process.cwd(), "public/data/replay/tift.json"), "utf8")) as {
    periods: { startTime: string; temperature: number }[];
  };
  const shift = Math.floor(Date.now() / 3_600_000) * 3_600_000 - Date.parse(replay.periods[0]!.startTime);
  const cold = replay.periods.map((period) => ({
    ...period,
    startTime: new Date(Date.parse(period.startTime) + shift).toISOString(),
    temperature: 40,
  }));
  await page.route("https://api.weather.gov/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/geo+json", body: JSON.stringify({ properties: { periods: cold } }) }),
  );
  await page.goto("/map");
  await waitForMap(page);
  await expect(page.locator("#map-summary")).toHaveText("No field has a 3-hour job anywhere in the forecast.");
  await expect(page.locator("[data-row=tift]")).toContainText("Most limiting:");
  await page.getByRole("button", { name: "Show the latest recorded morning with a window" }).click();
  await expect(page.getByRole("button", { name: "A recorded morning" })).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await waitForMap(page);
  await expect(page.locator("#map-summary")).not.toHaveText(/anywhere in the forecast/);
  await expect(page).toHaveURL(/mode=recorded&day=2026-10-\d\d/);
});

test("the map page never overflows and has no axe violations", async ({ page }) => {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(recordedPath);
    await waitForMap(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations, `map at ${width}px`).toEqual([]);
  }
});

test("the judge route opens the map on a morning every county could spray", async ({ page }) => {
  await page.goto("/judge");
  const href = await page.getByRole("link", { name: /Open the map/ }).getAttribute("href");
  expect(href).toBe("/map?mode=recorded&day=2026-10-15&hours=3&ahead=3");
  await page.goto(href!);
  await waitForMap(page);
  await expect(page.locator("a[data-county][data-status=open]")).toHaveCount(10);
});
