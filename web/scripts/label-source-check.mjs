// Usage: node scripts/label-source-check.mjs <base-url>
// Opens a clean replay, finds a Folex or Prep blocked clause, and requires a real text-layer highlight.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/label-source-check.mjs <base-url>");
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
page.on("pageerror", (error) => errors.push(String(error)));

let output;
try {
  await page.goto(`${base}/app?field=tift&tank=all&replay=tift`, { waitUntil: "networkidle" });
  await page.getByText("RECORDED", { exact: true }).waitFor();
  const blocked = page.locator('[data-hour-cell][data-state="BLOCKED"]');
  let card = null;
  for (let index = 0; index < await blocked.count(); index += 1) {
    await blocked.nth(index).click();
    const candidate = page.locator("#hour-detail [data-quote-card]").filter({ hasText: /FOLEX|PREP/ }).first();
    if (await candidate.count()) {
      card = candidate;
      break;
    }
  }
  if (!card) throw new Error("No Folex or Prep blocked clause was found in the Tift replay.");

  const product = (await card.locator("p.font-black").first().textContent())?.trim() ?? "unknown";
  const trigger = card.getByRole("button", { name: /Show on the label, page/ });
  const requestStarted = Date.now();
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/label-pdf/"));
  await trigger.click();
  const response = await responsePromise;
  await response.finished();
  const pdfFetchMs = Date.now() - requestStarted;
  const body = await response.body();
  const canvas = page.getByRole("dialog").locator("canvas");
  await canvas.waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[data-label-highlight="true"]').first().waitFor({ state: "visible", timeout: 10_000 });
  const highlights = await page.locator('[data-label-highlight="true"]').count();
  const pageLabel = (await trigger.textContent())?.trim() ?? "unknown";

  const stills = path.join(process.cwd(), "test-results", "stills");
  await mkdir(stills, { recursive: true });
  await page.screenshot({ path: path.join(stills, "label-dialog-1440.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: path.join(stills, "label-dialog-390.png"), animations: "disabled" });

  output = {
    base,
    product,
    pageLabel,
    status: response.status(),
    pdfFetchMs,
    pdfBytes: body.byteLength,
    highlights,
    consoleErrors: errors,
  };
} catch (error) {
  output = { base, error: error instanceof Error ? error.message : String(error), consoleErrors: errors };
}

await browser.close();
console.log(JSON.stringify(output, null, 2));
process.exit(output.status === 200 && output.pdfBytes > 5 && output.highlights > 0 && errors.length === 0 ? 0 : 1);
