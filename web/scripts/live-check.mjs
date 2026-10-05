// Live check against a deployed URL: fresh browser profile, no keys, real NWS fetch in the browser, WASM planner.
// Usage: node scripts/live-check.mjs https://labelhand-web.vercel.app
// Exits non-zero unless the page reports a LIVE forecast with at least one evaluated hour and no console errors.
import { chromium } from "@playwright/test";

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/live-check.mjs <base-url>");
  process.exit(2);
}
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const nws = [];
page.on("response", async (r) => {
  if (r.url().includes("api.weather.gov") && r.url().includes("forecast/hourly")) {
    try {
      const j = await r.json();
      nws.push({ status: r.status(), firstStart: j.properties?.periods?.[0]?.startTime, periods: j.properties?.periods?.length });
    } catch {
      nws.push({ status: r.status(), firstStart: null, periods: null });
    }
  }
});
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(`${base}/app?field=tift&tank=all`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /check .*forecast hours/i }).click();
await page.getByText(/FORECAST-PERMITTED\s*·/).first().waitFor({ timeout: 60000 });
const ms = Date.now() - t0;
const live = await page.getByText(/^LIVE$/).count();
const recorded = await page.getByText(/^RECORDED$/).count();
const summary = (await page.getByText(/FORECAST-PERMITTED\s*·/).first().textContent())?.trim();
// The first day heading on screen must be the day of the fetched forecast's first hour.
const firstDay = await page.locator('[aria-label$=" timeline"]').first().getAttribute("aria-label");
await browser.close();
const fresh = nws.length > 0 && nws.every((n) => n.status === 200 && n.periods > 0 && Date.now() - Date.parse(n.firstStart) < 3 * 3600e3);
// The timeline must start on the day of the fetched forecast's first hour (Georgia time), so the page renders that data.
const expectedDay = nws[0]?.firstStart
  ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" }).format(new Date(nws[0].firstStart))
  : null;
const rendersFetched = Boolean(expectedDay && firstDay?.startsWith(expectedDay));
console.log(JSON.stringify({ base, live, recorded, summary, firstDay, expectedDay, rendersFetched, nws, ms, consoleErrors: errors }, null, 1));
// LIVE must mean a fresh NWS hourly forecast fetched by this browser and drawn on screen, not the recorded fixture.
process.exit(live > 0 && recorded === 0 && fresh && rendersFetched && errors.length === 0 ? 0 : 1);
