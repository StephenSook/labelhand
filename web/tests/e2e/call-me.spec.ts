import { expect, test, type Page } from "@playwright/test";

const replayPath = "/app?field=tift&products=5481-504,228-653,228-659&hours=3&replay=tift";

async function openPlanner(page: Page) {
  await page.goto(replayPath);
  await expect(page.locator("[data-hour-cell]")).toHaveCount(156);
  await expect(page.locator("[data-call-me]")).toBeVisible();
}

test("verifies a number and subscribes it for the planned field and tank", async ({ page }) => {
  const sent: unknown[] = [];
  await page.route("**/api/alerts/start", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ verificationId: "11111111-1111-4111-8111-111111111111", status: "pending", channel: "sms" }) });
  });
  await page.route("**/api/alerts/confirm", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ subscriptionId: "sub", status: "active" }) });
  });
  await openPlanner(page);

  await page.getByLabel("US phone number").fill("(229) 555-0100");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.locator("[data-call-me]")).toHaveAttribute("data-call-me", "code");
  await page.getByLabel("Code from the text").fill("123456");
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page.locator("[data-call-me] [role=status]")).toContainText("You are subscribed");
  await expect(page.locator("[data-call-me]")).toHaveAttribute("data-call-me", "active");

  expect(sent).toEqual([
    { field: "tift", tankRegs: ["5481-504", "228-653", "228-659"], jobHours: 3, phoneNumber: "+12295550100", channel: "sms" },
    { verificationId: "11111111-1111-4111-8111-111111111111", code: "123456" },
  ]);
});

test("says plainly when phone alerts are not switched on", async ({ page }) => {
  await page.route("**/api/alerts/start", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Alerts are unavailable.", status: 503 }) }),
  );
  await openPlanner(page);
  await page.getByLabel("US phone number").fill("229-555-0100");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.locator("[data-call-me] [role=alert]")).toHaveText("Phone alerts are not switched on for this site yet.");
  await expect(page.locator("[data-call-me]")).toHaveAttribute("data-call-me", "form");
});

test("refuses a number that is not a US number before sending anything", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/alerts/start", (route) => {
    calls += 1;
    return route.abort();
  });
  await openPlanner(page);
  await page.getByLabel("US phone number").fill("555-0100");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.locator("[data-call-me] [role=alert]")).toHaveText("Enter a 10-digit US phone number.");
  expect(calls).toBe(0);
});
