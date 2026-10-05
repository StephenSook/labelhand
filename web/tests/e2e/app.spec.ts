import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const replayPath = "/app?field=tift&products=5481-504,264-700,264-418&hours=3&replay=tift";
const stillsDir = String.raw`C:\Users\STEVEB~1\AppData\Local\Temp\claude\C--Users-stevebillz\2a521d3f-5761-476e-8197-9d532949c28b\scratchpad\stills-ui`;

async function openReplay(page: Page) {
  await page.goto(replayPath);
  await expect(page.getByText("RECORDED", { exact: true })).toBeVisible();
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
}

async function waitForAutoRun(page: Page) {
  await expect(page.locator("#timeline")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-forecast-source]")).toHaveAttribute("data-forecast-source", /LIVE|RECORDED/);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Could not parse color: ${value}`);
    const linear = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test("the planner runs on first load without a click", async ({ page }) => {
  await page.goto("/app");
  await waitForAutoRun(page);
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
});

test("a field, product, and job-length deep link reproduces its state", async ({ page }) => {
  await page.goto("/app?field=worth&products=5481-504,264-700&hours=4");
  await waitForAutoRun(page);

  await expect(page.locator("#field")).toHaveValue("worth");
  await expect(page.locator("#job-hours")).toHaveValue("4");
  await expect(page.getByRole("checkbox", { name: /5481-504/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /264-700/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /264-418/ })).not.toBeChecked();
  await expect(page).toHaveURL(/field=worth.*products=5481-504%2C264-700.*hours=4/);

  await page.goto("/app?field=unknown&products=5481-504,unknown&hours=99");
  await waitForAutoRun(page);
  await expect(page.locator("#field")).toHaveValue("tift");
  await expect(page.locator("#job-hours")).toHaveValue("3");
  for (const reg of ["5481-504", "264-700", "264-418"]) {
    await expect(page.getByRole("checkbox", { name: new RegExp(reg) })).toBeChecked();
  }
});

test("the home hero runs a live or recorded planner check with a source time", async ({ page }) => {
  await page.goto("/");
  const card = page.locator("[data-live-hero]");
  await expect(card).toHaveAttribute("data-forecast-source", /LIVE|RECORDED/, { timeout: 15_000 });
  await expect(card.locator("time")).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);
  await expect(card).toHaveAttribute("data-permitted-hours", /\d+/);
  await expect(card).toHaveAttribute("data-field-check-hours", /\d+/);
  await expect(card).toHaveAttribute("data-blocked-hours", /\d+/);
});

test("every judge step resolves to its app target", async ({ page }) => {
  await page.goto("/judge");
  const links = await page.locator(".judge-step a[href^='/app']").evaluateAll((anchors) => (
    anchors.map((anchor) => (anchor as HTMLAnchorElement).getAttribute("href")).filter((href): href is string => Boolean(href))
  ));
  expect(links).toHaveLength(7);

  for (const href of links) {
    const response = await page.goto(href);
    expect(response?.status(), href).toBeLessThan(400);
    await waitForAutoRun(page);
    const target = decodeURIComponent(new URL(page.url()).hash.slice(1));
    expect(target, href).not.toBe("");
    await expect(page.locator(`#${target}`), href).toBeAttached();
  }

  await page.goto(`${replayPath}&question=${encodeURIComponent("Which label sets the strictest wind limit in this tank?")}#ask-the-tank`);
  await expect(page.locator("#tank-question")).toHaveValue("Which label sets the strictest wind limit in this tank?");
});

test("the recorded planner exposes every hour and its source quote", async ({ page }) => {
  await openReplay(page);

  const firstBlocked = page.locator('[data-hour-cell][data-state="BLOCKED"]').first();
  await expect(firstBlocked).toBeVisible();
  await firstBlocked.click();

  const quoteCard = page.locator("#hour-detail [data-quote-card]").first();
  await expect(quoteCard).toBeVisible();
  await expect(quoteCard).toContainText("Exact label quote");
  await expect(quoteCard).toContainText(/Page \d+/);
});

test("the label dialog reports a proxy failure and returns focus", async ({ page }) => {
  await page.route("**/api/label-pdf/**", (route) => route.fulfill({
    status: 502,
    contentType: "text/plain; charset=utf-8",
    body: "The EPA response was not a PDF. The %PDF- signature was missing.",
  }));
  await openReplay(page);
  await page.locator('[data-hour-cell][data-state="BLOCKED"]').first().click();

  const trigger = page.locator("[data-quote-card]").first().getByRole("button", { name: /Show on the label, page/ });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("The EPA response was not a PDF");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("a permitted window downloads a real PDF file", async ({ page }) => {
  await openReplay(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download spray record (PDF)" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/u);
  const file = await download.path();
  expect(file).not.toBeNull();
  const bytes = await readFile(file!);
  expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
});

test("the constraint panel runs an in-memory what-if through the planner", async ({ page }) => {
  await openReplay(page);

  const panel = page.getByRole("region", { name: "Why so few windows?" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("list", { name: "Top limiting clauses" }).getByRole("listitem")).toHaveCount(3);
  const dataRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/data/")) dataRequests.push(request.url());
  });
  await panel.getByRole("button", { name: /^Check without PREP/ }).click();

  const outcome = panel.locator("[data-what-if-result]");
  await expect(outcome).toContainText("31 of 156 forecast-permitted hours");
  await expect(outcome).toContainText("5 windows at least 3 hours long");
  expect(dataRequests).toEqual([]);
});

test("the home, planner, and judge pages never overflow their viewports", async ({ page }) => {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    for (const route of ["/", replayPath, "/judge"]) {
      if (route === replayPath) await openReplay(page);
      else await page.goto(route);

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

      expect(dimensions.document.scrollWidth, `${route} at ${width}px`).toBeLessThanOrEqual(dimensions.document.clientWidth);
      if (route === replayPath) {
        expect(dimensions.days.length, `${width}px should render day cards`).toBeGreaterThan(0);
        for (const day of dimensions.days) {
          expect(day.scrollWidth, `${width}px ${day.day} day width`).toBeLessThanOrEqual(day.clientWidth + 1);
        }
      }
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
  await expect(page.locator("#hour-detail [data-quote-card]").first()).toContainText("Exact label quote");
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

test("the disabled Ask the tank button keeps readable contrast", async ({ page }) => {
  await page.goto("/app");
  const button = page.getByRole("button", { name: "Run Ask the tank" });
  await expect(button).toBeDisabled();
  const styles = await button.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      opacity: computed.opacity,
    };
  });
  expect(styles.opacity).toBe("1");
  expect(contrastRatio(styles.color, styles.backgroundColor)).toBeGreaterThanOrEqual(4.5);
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

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    for (const route of [
      { name: "home", path: "/" },
      { name: "app", path: "/app" },
      { name: "judge", path: "/judge" },
    ]) {
      if (route.name === "app") {
        await page.goto(route.path);
        await waitForAutoRun(page);
      } else {
        await page.goto(route.path);
        if (route.name === "home") {
          await expect(page.locator("[data-live-hero]")).toHaveAttribute("data-forecast-source", /LIVE|RECORDED/, { timeout: 15_000 });
        }
      }

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations, `${route.name} at ${width}px`).toEqual([]);

      await page.screenshot({
        path: path.join(stillsDir, `${route.name}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});
