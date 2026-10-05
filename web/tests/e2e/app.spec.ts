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

test("the recorded planner never overflows its viewport or day cards", async ({ page }) => {
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openReplay(page);

    const dimensions = await page.evaluate(() => ({
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      days: Array.from(document.querySelectorAll<HTMLElement>("[data-day]"), (day) => ({
        day: day.dataset.day,
        clientWidth: day.clientWidth,
        scrollWidth: day.scrollWidth,
      })),
    }));

    expect(dimensions.days.length, `${width}px should render day cards`).toBeGreaterThan(0);
    expect(dimensions.document.scrollWidth, `${width}px document width`).toBeLessThanOrEqual(dimensions.document.clientWidth);
    for (const day of dimensions.days) {
      expect(day.scrollWidth, `${width}px ${day.day} day width`).toBeLessThanOrEqual(day.clientWidth + 1);
    }
  }
});

test("the phone timeline groups hours into runs that open the existing detail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openReplay(page);

  const firstDay = page.locator("[data-day]").first();
  const disclosure = firstDay.locator("details");
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await disclosure.locator("summary").click();
  }

  const firstRun = firstDay.locator("[data-run-row]").first();
  await expect(firstRun).toBeVisible();
  await expect(firstRun).toHaveCSS("min-height", "44px");
  await firstRun.click();
  await expect(page.locator("[data-quote-card]").first()).toContainText("Exact label quote");
});

test("the last hour of a full day stays inside its card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page);

  const fullDay = page.locator('[data-day][data-day-hours="24"]').first();
  const lastHour = fullDay.locator("[data-hour-cell]").nth(23);
  const [cardBox, hourBox] = await Promise.all([fullDay.boundingBox(), lastHour.boundingBox()]);

  expect(cardBox).not.toBeNull();
  expect(hourBox).not.toBeNull();
  expect(hourBox!.x + hourBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
});

test("Ask the tank renders all example questions without calling the model", async ({ page }) => {
  await page.goto("/app");
  const section = page.getByRole("region", { name: "Ask the tank." });
  await expect(section).toBeVisible();
  for (const example of [
    "When can I spray all three at Tift this week for a 4-hour job?",
    "Why is the next blocked hour at Worth blocked?",
    "Which label sets the strictest wind limit in this tank?",
  ]) {
    await expect(page.getByRole("button", { name: example })).toBeVisible();
  }
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
