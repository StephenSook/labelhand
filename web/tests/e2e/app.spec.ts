import { mkdir } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const replayPath = "/app?field=tift&tank=all&replay=tift";
const stillsDir = path.join(process.cwd(), "test-results", "stills");

async function openReplay(page: Page) {
  await page.goto(replayPath);
  await expect(page.getByText("RECORDED", { exact: true })).toBeVisible();
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
}

test("the recorded planner exposes every hour and its source quote", async ({ page }) => {
  await openReplay(page);

  const firstBlocked = page.locator('[data-hour-cell][data-state="BLOCKED"]').first();
  await expect(firstBlocked).toBeVisible();
  await firstBlocked.click();

  const quoteCard = page.locator("[data-quote-card]").first();
  await expect(quoteCard).toBeVisible();
  await expect(quoteCard).toContainText("Exact label quote");
  await expect(quoteCard).toContainText(/Page \d+/);
});

test("every page names the product exactly once in its title", async ({ page }) => {
  for (const route of ["/", "/app", "/judge"]) {
    await page.goto(route);
    const title = await page.title();
    expect(title.match(/Labelhand/g)?.length ?? 0, `${route}: "${title}"`).toBe(1);
  }
});

test("all Tier 1 pages have zero axe violations and render the requested stills", async ({ page }) => {
  await mkdir(stillsDir, { recursive: true });

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    for (const route of [
      { name: "home", path: "/" },
      { name: "app", path: replayPath },
      { name: "judge", path: "/judge" },
    ]) {
      if (route.name === "app") {
        await openReplay(page);
      } else {
        await page.goto(route.path);
      }

      if (width === 390 || width === 1440) {
        const scan = await new AxeBuilder({ page }).analyze();
        expect(scan.violations, `${route.name} at ${width}px`).toEqual([]);
      }

      await page.screenshot({
        path: path.join(stillsDir, `${route.name}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});
