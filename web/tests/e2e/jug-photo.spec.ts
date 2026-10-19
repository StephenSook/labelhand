import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The photo route's answer is the real Folex 6 EC result from eval/results/photo-read-2026-10-19.json
// (Nemotron 3.5 Super VL read 5481-504 from the rendered front panel). The uploaded file only has to
// be a valid image for the browser's resize step; the route is served from the recording so CI spends
// no Token Factory credit.
const fixtures = path.join(process.cwd(), "tests/fixtures/live");

test("a jug photo of a scored product is read, checked against EPA, and selects its scored chip", async ({ page }) => {
  const photo = await readFile(path.join(fixtures, "photo-folex-6-ec.json"), "utf8");
  const stream = await readFile(path.join(fixtures, "axial-xl-100-1256.ndjson"), "utf8");
  let photoRequests = 0;
  let compileRequests = 0;
  await page.route("**/api/labels/photo", (route) => {
    photoRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: photo });
  });
  await page.route("**/api/labels/compile", (route) => {
    compileRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: stream });
  });

  await page.goto("/app?field=tift&products=none&hours=3&replay=tift");
  await page.locator("[data-photo-input]").setInputFiles(path.join(fixtures, "blank-label-photo.jpg"));

  const result = page.locator("[data-photo-result='MATCHED']");
  await expect(result).toContainText("5481-504");
  await expect(result).toContainText("EPA's records agree");
  expect(photoRequests).toBe(1);

  await result.getByRole("button").click();
  await expect(page.getByRole("checkbox", { name: /Folex 6 EC/ })).toBeChecked();
  await expect(page.locator("[data-live-label]")).toHaveCount(0);
  expect(compileRequests).toBe(0);
});
