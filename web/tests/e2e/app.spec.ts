import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { bulletinMonthLabel, easternMonth, monthIndex } from "../../src/lib/bulletins";

const replayPath = "/app?field=tift&products=5481-504,228-653,228-659&hours=3&replay=tift";
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
  await expect(page.locator("#timeline")).toContainText("Hours are Eastern time");
});

test("a field, product, and job-length deep link reproduces its state", async ({ page }) => {
  await page.goto("/app?field=worth&products=5481-504,228-653&hours=4");
  await waitForAutoRun(page);

  await expect(page.locator("#field")).toHaveValue("worth");
  await expect(page.locator("#job-hours")).toHaveValue("4");
  await expect(page.getByRole("checkbox", { name: /5481-504/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /228-653/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /228-659/ })).not.toBeChecked();
  await expect(page).toHaveURL(/field=worth.*products=5481-504%2C228-653.*hours=4/);

  await page.goto("/app?field=unknown&products=5481-504,unknown&hours=99");
  await waitForAutoRun(page);
  await expect(page.locator("#field")).toHaveValue("tift");
  await expect(page.locator("#job-hours")).toHaveValue("3");
  for (const reg of ["5481-504", "228-653", "228-659"]) {
    await expect(page.getByRole("checkbox", { name: new RegExp(reg) })).toBeChecked();
  }
});

test("unticking a product re-checks the tank on the forecast already shown", async ({ page }) => {
  const card = page.locator("#next-window");
  const tank = page.getByLabel(/^Tank products:/);

  // What a fresh load of the two-product tank shows on the same recorded forecast.
  await page.goto("/app?field=tift&products=228-653,228-659&hours=3&replay=tift");
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
  // Read the card once its Bulletins Live! Two line has an answer, not while it is still checking.
  await expect(card.locator("[data-bulletin]")).not.toHaveAttribute("data-bulletin-status", "checking");
  const expectedCard = (await card.textContent()) ?? "";
  expect(expectedCard).toContain("Tank: FreeFall SC, Super Boll");

  await openReplay(page);
  await expect(tank).toHaveAttribute("aria-label", /5481-504/);
  await page.getByRole("checkbox", { name: /5481-504/ }).uncheck();

  await expect(tank).not.toHaveAttribute("aria-label", /5481-504/);
  await expect(card).toHaveText(expectedCard);
  await expect(page.getByText("RECORDED", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/products=228-653%2C228-659.*replay=tift/);
});

test("with no live check the next-window card points to this field's Endangered Species Protection Bulletin", async ({ page }) => {
  // The test server runs with LABELHAND_BLT_LIVE=off, so /api/bulletins answers unavailable.
  await openReplay(page);
  const bulletin = page.locator("#next-window [data-bulletin]");
  await expect(bulletin).toHaveAttribute("data-bulletin-status", "unavailable");
  await expect(bulletin).toContainText("Endangered species limits are not checked here.");
  await expect(bulletin).toContainText("31.4, -83.6");
  const link = bulletin.getByRole("link", { name: "Bulletins Live! Two" });
  await expect(link).toHaveAttribute("href", "https://blt.epa.gov/blt/public");
  await expect(link).toHaveAttribute("target", "_blank");
});

test("the next-window card shows each Bulletins Live! Two answer without calling EPA", async ({ page }) => {
  const fixtures = path.join(process.cwd(), "tests/fixtures/blt");
  // Answers the checker returns for recorded EPA responses (pinned in tests/blt.test.ts).
  const noLimits = JSON.parse(await readFile(path.join(fixtures, "answer-tift-tank-2026-11.json"), "utf8"));
  const stryax = JSON.parse(await readFile(path.join(fixtures, "answer-dooly-stryax-2026-11.json"), "utf8"));
  // The real STRYAX limitation in PULA 121, credited to Dropp SC in this test only so the card has a
  // tank product to list it under. Bulletins Live! Two lists no limitation for Dropp SC.
  const limits = {
    ...stryax,
    limitations: (stryax.limitations as Array<Record<string, unknown>>).map((limitation) => ({ ...limitation, reg: "264-700" })),
  };
  const unavailable = { status: "unavailable", reason: "BLT pulas_public returned HTTP 500." };

  const asked: URL[] = [];
  const epaRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("epa.gov")) epaRequests.push(request.url());
  });
  let reply: { status: number; body: unknown } = { status: 200, body: noLimits };
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/bulletins", async (route) => {
    asked.push(new URL(route.request().url()));
    await held;
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });

  const card = page.locator("#next-window");
  const bulletin = card.locator("[data-bulletin]");
  await openReplay(page);
  await expect(bulletin).toHaveAttribute("data-bulletin-status", "checking");
  await expect(bulletin).toHaveText("Checking EPA's Bulletins Live! Two for endangered species limits at this field...");

  const first = asked[0];
  expect(first.searchParams.get("lat")).toBe("31.4");
  expect(first.searchParams.get("lon")).toBe("-83.6");
  expect(first.searchParams.get("regs")).toBe("5481-504,264-700,264-418");
  const month = first.searchParams.get("month") ?? "";
  const current = monthIndex(easternMonth(new Date()));
  expect(monthIndex(month)).not.toBeNull();
  expect(monthIndex(month)! - current!).toBeGreaterThanOrEqual(0);
  expect(monthIndex(month)! - current!).toBeLessThanOrEqual(6);
  const monthLabel = bulletinMonthLabel(month);

  // Green card (the recorded tift forecast has a window), no limits.
  release();
  await expect(bulletin).toHaveAttribute("data-bulletin-status", "no-limits");
  await expect(card.getByRole("button", { name: "Show this window in the timeline" })).toBeVisible();
  await expect(bulletin).toHaveText(
    `EPA Bulletins Live! Two lists no endangered species limits for these products at this field in ${monthLabel}. Informational, not a Bulletin.`,
  );
  await expect(bulletin.getByRole("link", { name: "Bulletins Live! Two" })).toHaveAttribute("href", "https://blt.epa.gov/blt/public");
  await expect(bulletin).toHaveAttribute("data-bulletin-checked-at", "2026-10-20T21:00:00.000Z");
  expect((await new AxeBuilder({ page }).include("#next-window").analyze()).violations).toEqual([]);

  // Limits found: each limitation is listed under its tank product with its code and PULA.
  reply = { status: 200, body: limits };
  await page.getByRole("checkbox", { name: /5481-504/ }).uncheck();
  await expect(bulletin).toHaveAttribute("data-bulletin-status", "limits");
  expect(asked.at(-1)?.searchParams.get("regs")).toBe("264-700,264-418");
  const dropp = bulletin.locator('[data-bulletin-reg="264-700"]');
  await expect(dropp).toContainText("Dropp SC, EPA Reg. 264-700");
  await expect(dropp.locator("[data-bulletin-limitation]")).toHaveCount(1);
  await expect(dropp.locator("[data-bulletin-limitation]")).toContainText("DC125, PULA 121: This crop use is located within a PULA.");
  await expect(bulletin).toContainText(`lists endangered species limits for these products at this field in ${monthLabel}. Informational, not a Bulletin.`);
  await expect(bulletin).toContainText("Search 31.4, -83.6 in Bulletins Live! Two. Get the official bulletin there before you spray.");
  await expect(bulletin.getByRole("link", { name: "Bulletins Live! Two" })).toHaveAttribute("target", "_blank");
  expect((await new AxeBuilder({ page }).include("#next-window").analyze()).violations).toEqual([]);

  // Unavailable: the manual pointer comes back.
  reply = { status: 502, body: unavailable };
  await page.getByRole("checkbox", { name: /264-418/ }).uncheck();
  await expect(bulletin).toHaveAttribute("data-bulletin-status", "unavailable");
  expect(asked.at(-1)?.searchParams.get("regs")).toBe("264-700");
  await expect(bulletin).toContainText("Endangered species limits are not checked here. In EPA's Bulletins Live! Two, search 31.4, -83.6");

  // Yellow card (no window fits a 12-hour job), limits found.
  reply = { status: 200, body: limits };
  await page.goto("/app?field=tift&products=264-700&hours=12&replay=tift");
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
  await expect(card).toContainText("No forecast-permitted window fits this 12-hour job");
  await expect(bulletin).toHaveAttribute("data-bulletin-status", "limits");
  expect(monthIndex(asked.at(-1)?.searchParams.get("month") ?? "")).toBe(current);
  expect((await new AxeBuilder({ page }).include("#next-window").analyze()).violations).toEqual([]);

  expect(epaRequests).toEqual([]);
});

test("the home hero runs a live or recorded planner check with a source time", async ({ page }) => {
  await page.goto("/");
  const card = page.locator("[data-live-hero]");
  await expect(card).toHaveAttribute("data-forecast-source", /LIVE|RECORDED/, { timeout: 15_000 });
  await expect(card.locator("time")).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);
  await expect(card).toHaveAttribute("data-permitted-hours", /\d+/);
  await expect(card).toHaveAttribute("data-field-check-hours", /\d+/);
  await expect(card).toHaveAttribute("data-blocked-hours", /\d+/);
  // A window's clock times must say which timezone they are in; with no window there are no times.
  await expect(card).toContainText(/Eastern time|No three-hour permitted window/);
});

test("every judge step resolves to its app target", async ({ page }) => {
  // The live-label step would spend Token Factory credit; serve the recorded real compile instead.
  const stream = await readFile(path.join(process.cwd(), "tests/fixtures/live/axial-xl-100-1256.ndjson"), "utf8");
  await page.route("**/api/labels/compile", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: stream }));
  await page.goto("/judge");
  const links = await page.locator(".judge-step a[href^='/app']").evaluateAll((anchors) => (
    anchors.map((anchor) => (anchor as HTMLAnchorElement).getAttribute("href")).filter((href): href is string => Boolean(href))
  ));
  expect(links).toHaveLength(9);

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
  await panel.getByRole("button", { name: /^Check without .*EPA Reg\. 228-659$/ }).click();

  const outcome = panel.locator("[data-what-if-result]");
  await expect(outcome).toContainText("31 of 156 forecast-permitted hours");
  await expect(outcome).toContainText("5 windows at least 3 hours long");
  expect(dataRequests).toEqual([]);
});

test("the home, planner, judge, and proof pages never overflow their viewports", async ({ page }) => {
  // 768 switches phone runs to the grid; 1024 widens the grid to 24 hour columns.
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    for (const route of ["/", replayPath, "/judge", "/proof"]) {
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
  for (const route of ["/", "/app", "/judge", "/proof"]) {
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
      { name: "proof", path: "/proof" },
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

// Season replay runs on the committed NWS recording, so these checks hold in any month.
test("the season strip replays the best recorded morning with its window and stability", async ({ page }) => {
  await page.goto("/app?field=tift&products=5481-504,228-653,228-659&hours=4");
  await waitForAutoRun(page);
  const strip = page.locator("#season-replay ol li");
  await expect(strip.first()).toBeVisible({ timeout: 30_000 });
  expect(await strip.count()).toBeGreaterThanOrEqual(15);

  await page.locator("#season-replay button", { hasText: "Replay the best morning" }).click();
  await expect(page.locator("#next-window")).toContainText("Season replay", { timeout: 30_000 });
  await expect(page.locator("[data-forecast-source]")).toHaveAttribute("data-forecast-source", "RECORDED");
  await expect(page).toHaveURL(/issued=2026-/);
  await expect(page.locator("#next-window")).toContainText("consecutive");
  await expect(page.locator("[data-window-stability]")).toContainText(/\d+ of the \d+ forecasts recorded just before this one/, { timeout: 30_000 });
});

test("an issued deep link reopens that recorded forecast", async ({ page }) => {
  await page.goto("/app?field=tift&products=5481-504,228-653,228-659&hours=4&issued=2026-10-10T11:07:02%2B00:00");
  await expect(page.locator("#next-window")).toContainText("Season replay", { timeout: 30_000 });
  await expect(page.locator("#next-window")).toContainText("Oct 10, 2026");
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
});

test("the home page shows the forecast check-back from the committed summary", async ({ page }) => {
  const summary = JSON.parse(await readFile(path.join(process.cwd(), "public/data/checkback.json"), "utf8")) as {
    tank_mix: { pooled: { held: number; broke: number } };
  };
  const { held, broke } = summary.tank_mix.pooled;
  await page.goto("/");
  const card = page.locator(".checkback-card");
  await expect(card).toContainText(`${held} of ${held + broke}`);
  await expect(card.locator("[data-checkback-row]")).toHaveCount(4);
});

test("the proof page lists every gold clause and every broken forecast hour", async ({ page }) => {
  const proof = JSON.parse(await readFile(path.join(process.cwd(), "public/data/proof.json"), "utf8")) as {
    gold: unknown[];
    checkback: { misses: unknown[] };
  };
  await page.goto("/proof");
  await page.locator("details.proof-all summary").click();
  await expect(page.locator("#label-clauses .proof-all tbody tr")).toHaveCount(proof.gold.length);
  for (const day of await page.locator("details.proof-day").all()) await day.locator("summary").click();
  await expect(page.locator("#forecast-misses tbody tr")).toHaveCount(proof.checkback.misses.length);
  const issued = page.locator("#forecast-misses tbody a").first();
  await expect(issued).toHaveAttribute("href", /\/app\?field=.+&issued=2026-.+#season-replay/);
});

test("an answer's window chips name the hours, not the window index", async ({ page }) => {
  // Two scripted model steps: check_tank on the page's recorded forecast, then a grounded final answer.
  let step = 0;
  await page.route("**/api/agent", (route) => {
    step += 1;
    const call = step === 1
      ? { id: "call-check", type: "function", function: { name: "check_tank", arguments: JSON.stringify({ field: "tift", products: ["5481-504", "228-653", "228-659"], job_hours: 3, forecast: "recorded" }) } }
      : { id: "call-final", type: "function", function: { name: "final_answer", arguments: JSON.stringify({ summary: "Window 0 is forecast-permitted.", cited_rule_ids: [], window_indices: [0] }) } };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: { role: "assistant", content: null, tool_calls: [call] }, model: "scripted", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, requestId: `scripted-${step}` }),
    });
  });
  await page.goto(`${replayPath}&question=${encodeURIComponent("When can I spray?")}#ask-the-tank`);
  await waitForAutoRun(page);
  await page.locator("#ask-the-tank button[type=submit]").click();

  const chip = page.locator("[data-agent-result] [data-agent-window='0']");
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveText(/^\w{3}, \w{3} \d{1,2}, \d{1,2} (AM|PM) to \w{3}, \w{3} \d{1,2}, \d{1,2} (AM|PM) \(\d+ h\)$/u);
  await expect(chip).not.toHaveText("Window 0");
});
