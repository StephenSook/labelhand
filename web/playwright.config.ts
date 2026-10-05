import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3107";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: "pnpm start --port 3107", url: baseURL, reuseExistingServer: true, timeout: 120_000 },
});
