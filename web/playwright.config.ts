import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3107";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Tests mock NWS and the label APIs with page.route, which a service worker would bypass, so
  // workers are blocked here and allowed only in tests/e2e/pwa.spec.ts.
  use: { baseURL, trace: "retain-on-failure", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The test server never asks EPA Bulletins Live! Two; tests that need an answer route
  // /api/bulletins to a recorded one.
  webServer: process.env.BASE_URL
    ? undefined
    : {
      command: "pnpm start --port 3107",
      url: baseURL,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { LABELHAND_BLT_LIVE: "off" },
    },
});
