import { readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

// The version list and the text comparison come from EPA through the app's own routes. The test server must not ask
// EPA, so both are served from answers those routes gave on 2026-10-21 (scripts/record-changes-fixtures.ts). The rule
// and planner-hour comparison is committed data the page renders itself.
const OUTAGE =
  "EPA's label system (PPLS) did not answer for EPA Reg. 228-653, so the list of accepted label versions cannot be shown right now. PPLS limits bursts of requests; try again in a few minutes. (EPA label list for 228-653 could not be reached.)";

type Side = { pages: number[]; parts: Array<{ page: number; text: string; marked: boolean }> };
type RecordedDiff = { from: { fileName: string; sha256: string }; to: { fileName: string; sha256: string }; diff: { changes: Array<{ conditions: string[]; before: Side | null; after: Side | null }> } };

async function fixture(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), "tests", "fixtures", "changes", name), "utf8");
}

async function serveRecorded(page: Page, reg: string, versions: "recorded" | "down" = "recorded"): Promise<string[]> {
  const diffRequests: string[] = [];
  await page.route(`**/api/labels/versions/${reg}`, async (route) => {
    if (versions === "down") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: OUTAGE, status: 503 }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: await fixture(`versions-${reg}.json`) });
  });
  await page.route((url) => url.pathname === "/api/labels/diff", async (route) => {
    diffRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: await fixture(`diff-${reg}.json`) });
  });
  return diffRequests;
}

test("FreeFall SC: every accepted version, the spray-condition change first, then rules and planner hours", async ({ page }) => {
  const diffRequests = await serveRecorded(page, "228-653");
  await page.goto("/changes/228-653");

  await expect(page.locator("[data-version]")).toHaveCount(8);
  await expect(page.locator('[data-version="000228-00653-20210514.pdf"]')).toContainText("Labelhand plans with this one");
  await expect(page.locator('[data-pick="from"]')).toHaveValue("000228-00653-20210127.pdf");
  await expect(page.locator('[data-pick="to"]')).toHaveValue("000228-00653-20210514.pdf");
  const requested = new URL(diffRequests[0]).searchParams;
  expect([requested.get("reg"), requested.get("from"), requested.get("to")]).toEqual(["228-653", "000228-00653-20210127.pdf", "000228-00653-20210514.pdf"]);

  await expect(page.locator("[data-diff-summary]")).toContainText("42 changes, 1 of them in a sentence that mentions a spray condition.");
  await expect(page.locator("[data-blank-pages]")).toContainText("Pages 1 and 2 of the January 27, 2021 PDF have no text layer");
  const spray = page.locator("[data-spray-changes] > li");
  await expect(spray).toHaveCount(1);
  await expect(spray).toContainText("temperature");
  await expect(spray.locator('[data-side="after"] mark')).toHaveText(["(COC’s) or"]);
  await expect(page.locator("[data-other-changes] > summary")).toHaveText("Every other change (41)");

  const rules = page.locator('[data-rule-changes="compiled"]');
  await expect(rules).toContainText("That compile cost $0.62.");
  await expect(rules.locator("[data-hours-moved]")).toHaveAttribute("data-hours-moved", "0");
  await expect(rules.locator("[data-label-changed]")).toHaveAttribute("data-label-changed", "5");
  await expect(rules.locator("[data-compile-only]")).toHaveAttribute("data-compile-only", "100");
  await expect(rules.locator("[data-hours-table] tbody tr")).toHaveCount(4);
  await expect(rules.locator("[data-label-changed-rules] > li")).toHaveCount(5);
  await expect(rules.locator("[data-citing-note]")).toContainText("only the January 27, 2021 compile acts on");
});

test("a change opens the earlier label's own PDF, held to the SHA-256 that was compared, at its page", async ({ page }) => {
  await serveRecorded(page, "228-653");
  const recorded = JSON.parse(await fixture("diff-228-653.json")) as RecordedDiff;
  const before = recorded.diff.changes.find((change) => change.conditions.length > 0)!.before!;
  const focus = before.parts.find((part) => part.marked) ?? before.parts[0];
  // A PDF made here, with the compared sentence on its page, stands in for EPA's file in the route answer.
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= focus.page; n += 1) {
    document.addPage().drawText(n === focus.page ? focus.text.replace(/[^\x20-\x7e]/g, "") : `Page ${n}`, { x: 20, y: 700, font, size: 4 });
  }
  const bytes = await document.save();
  const pdfRequests: URL[] = [];
  await page.route((url) => url.pathname === "/api/label-pdf/228-653", async (route) => {
    pdfRequests.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: "application/pdf", body: Buffer.from(bytes) });
  });

  await page.goto("/changes/228-653");
  const button = page.locator("[data-spray-changes] [data-side='before']").getByRole("button", { name: /^Show on the/ });
  await expect(button).toHaveText(`Show on the January 27, 2021 label, page ${focus.page}`);
  await button.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`page ${focus.page}`);
  await expect(dialog).toContainText("Accepted 2021-01-27.");
  await expect(dialog.locator("[data-label-page]")).toBeVisible();
  expect(pdfRequests[0].searchParams.get("file")).toBe(recorded.from.fileName);
  expect(pdfRequests[0].searchParams.get("sha256")).toBe(recorded.from.sha256);
  // The dialog shows a version on its own terms; it does not link back to the page it was opened from.
  await expect(dialog.locator("[data-changes-link]")).toHaveCount(0);
});

test("when EPA PPLS does not answer, the page says so plainly and still compares the label Labelhand knows", async ({ page }) => {
  const diffRequests = await serveRecorded(page, "228-653", "down");
  await page.goto("/changes/228-653");

  await expect(page.locator("[data-ppls-error]")).toHaveText(OUTAGE);
  await expect(page.locator("[data-version]")).toHaveCount(0);
  // The two PDFs come from EPA's file server, not PPLS, so the compiled pair is still compared.
  await expect(page.locator("[data-diff-summary]")).toContainText("42 changes");
  expect(new URL(diffRequests[0]).searchParams.get("from")).toBe("000228-00653-20210127.pdf");
  await expect(page.locator('[data-rule-changes="compiled"]')).toBeVisible();
});

test("Folex 6 EC: the label before the one Labelhand uses is a scan, and the page says so instead of guessing", async ({ page }) => {
  await serveRecorded(page, "5481-504");
  await page.goto("/changes/5481-504");

  await expect(page.locator("[data-version]")).toHaveCount(5);
  await expect(page.locator("[data-scan]")).toContainText("The February 27, 2025 PDF has no text layer on any of its 11 pages");
  await expect(page.locator('[data-rule-changes="not-compiled"]')).toContainText("11 of 11 pages have no readable text layer; the PDF is a scan.");
});

test("Super Boll: no changed sentence mentions a spray condition, and no rule difference is a label change", async ({ page }) => {
  await serveRecorded(page, "228-659");
  await page.goto("/changes/228-659");

  await expect(page.locator("[data-no-spray-changes]")).toBeVisible();
  await expect(page.locator("[data-other-changes] > summary")).toHaveText("Every other change (14)");
  await expect(page.locator("[data-no-label-changed-rules]")).toBeVisible();
  await expect(page.locator("[data-hours-moved]")).toHaveAttribute("data-hours-moved", "0");
});

test("a label Labelhand does not ship has no rule comparison and says why", async ({ page }) => {
  await page.route("**/api/labels/versions/100-1256", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "EPA's label system (PPLS) did not answer.", status: 503 }) }));
  await page.goto("/changes/100-1256");
  await expect(page.locator("[data-ppls-error]")).toBeVisible();
  await expect(page.locator('[data-rule-changes="none"]')).toContainText("only for the three labels it ships");
});

test("each product in the tank and the label dialog link to what changed on that label", async ({ page }) => {
  await page.route("**/api/label-pdf/**", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "No PDF in this test." }));
  await page.goto("/app?field=tift&products=5481-504,228-653,228-659&hours=3&replay=tift&hour=first-blocked#show-on-label");
  for (const reg of ["5481-504", "228-653", "228-659"]) {
    await expect(page.locator(`a[data-changes-link="${reg}"]`)).toHaveAttribute("href", `/changes/${reg}`);
  }
  await page.locator("#show-on-label").click();
  const link = page.getByRole("dialog").locator("[data-changes-link]");
  await expect(link).toHaveText("What changed since the last label");
  await expect(link).toHaveAttribute("href", /^\/changes\/(5481-504|228-653|228-659)$/);
});

test("the label time machine has no axe violations and never overflows a phone or a desktop", async ({ page }) => {
  for (const reg of ["228-653", "5481-504"]) await serveRecorded(page, reg);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const reg of ["228-653", "5481-504"]) {
      await page.goto(`/changes/${reg}`);
      await expect(page.locator("[data-diff-summary], [data-scan]")).toBeVisible();
      await page.locator("details").evaluateAll((all) => all.forEach((details) => { (details as HTMLDetailsElement).open = true; }));
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations, `${reg} at ${width}px`).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${reg} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
