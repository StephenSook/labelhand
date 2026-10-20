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

  // One first visit, no reload: the forecast lands before the worker controls the page, and the
  // page must still hand it over for the next visit.
  await page.goto("/app?field=tift&products=5481-504,228-653,228-659&hours=3");
  await expect(page.locator("[data-forecast-source]")).toHaveAttribute("data-forecast-source", "LIVE", { timeout: 30_000 });
  await expect(page.locator("[data-offline-copy]")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open("labelhand-forecasts")).keys()).length), { timeout: 30_000 })
    .toBe(1);
  // Every same-origin file this visit loaded is stored, including the ones that finished after the
  // worker was ready, or the offline open below would be missing a script or the planner.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const loaded = performance
            .getEntriesByType("resource")
            .map((entry) => new URL(entry.name))
            .filter((url) => url.origin === location.origin && !url.pathname.startsWith("/api/") && !url.searchParams.has("_rsc"));
          const missing: string[] = [];
          for (const url of loaded) if (!(await caches.match(url.href))) missing.push(url.pathname);
          return missing;
        }),
      { timeout: 30_000 },
    )
    .toEqual([]);

  await context.unroute("https://api.weather.gov/**");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-offline-copy]")).toHaveText("OFFLINE COPY", { timeout: 30_000 });
  await expect(page.locator("#next-window")).toContainText("No connection: this is the last NWS forecast this device saved");
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
  await context.setOffline(false);
});
