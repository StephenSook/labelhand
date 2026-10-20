import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("the app is installable: manifest, icons and service worker are served", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const body = await manifest.json() as { name: string; start_url: string; display: string; icons: Array<{ src: string; purpose: string }> };
  expect(body).toMatchObject({ name: "Labelhand", start_url: "/app", display: "standalone" });
  expect(body.icons.map((icon) => icon.purpose).sort()).toEqual(["any", "any", "maskable"]);
  for (const icon of body.icons) {
    const response = await request.get(icon.src);
    expect(response.ok(), icon.src).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  const worker = await request.get("/sw.js");
  expect(worker.ok()).toBe(true);
  expect(worker.headers()["content-type"]).toMatch(/javascript/);
});

test("with no signal the planner opens and checks the last saved forecast, labelled as a copy", async ({ context, page }) => {
  // A recorded Tift forecast moved to start this hour stands in for NWS, served to the page and the worker.
  const replay = JSON.parse(await readFile(path.join(process.cwd(), "public/data/replay/tift.json"), "utf8")) as {
    periods: Array<{ startTime: string }>;
  };
  const shift = Math.floor(Date.now() / 3_600_000) * 3_600_000 - Date.parse(replay.periods[0]!.startTime);
  const periods = replay.periods.map((period) => ({ ...period, startTime: new Date(Date.parse(period.startTime) + shift).toISOString() }));
  await context.route("https://api.weather.gov/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/geo+json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ properties: { periods } }) }),
  );

  await page.goto("/app?field=tift&products=5481-504,264-700,264-418&hours=3");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Reload under the worker's control so it stores this page's forecast and assets.
  await page.reload();
  await expect(page.locator("[data-forecast-source]")).toHaveAttribute("data-forecast-source", "LIVE", { timeout: 30_000 });
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.locator("[data-offline-copy]")).toHaveCount(0);

  await context.unroute("https://api.weather.gov/**");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-offline-copy]")).toHaveText("OFFLINE COPY", { timeout: 30_000 });
  await expect(page.locator("#next-window")).toContainText("No connection: this is the last NWS forecast this device saved");
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
  await context.setOffline(false);
});
