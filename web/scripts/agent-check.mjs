import { chromium } from "@playwright/test";

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error("Usage: node scripts/agent-check.mjs <base-url>");
  process.exit(2);
}

const model = "nvidia/Nemotron-3_5-Lightning";
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL("/app", baseUrl).toString(), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "When can I spray all three at Tift this week for a 4-hour job?" }).click();
  await page.getByRole("button", { name: "Run Ask the tank" }).click();
  const outcome = page.locator("[data-agent-result], #ask-the-tank [role=alert]");
  await outcome.waitFor({ state: "visible", timeout: 120_000 });
  const visibleError = page.locator("#ask-the-tank [role=alert]");
  if (await visibleError.isVisible()) {
    throw new Error(`Ask the tank failed: ${(await visibleError.textContent())?.trim() ?? "unknown error"}`);
  }

  const report = await page.evaluate((expectedModel) => {
    const modelCalls = [...document.querySelectorAll("[data-model-call]")].map((element) => ({
      model: element.getAttribute("data-model"),
      tokensIn: Number(element.getAttribute("data-tokens-in")),
      tokensOut: Number(element.getAttribute("data-tokens-out")),
      text: element.textContent?.trim() ?? "",
    }));
    const tools = [...document.querySelectorAll("[data-tool-call]")].map((element) => ({
      name: element.getAttribute("data-tool-call"),
      text: element.textContent?.trim() ?? "",
    }));
    const guard = document.querySelector('[data-agent-guard="passed"]')?.textContent?.trim() ?? null;
    const trace = document.querySelector("[data-agent-trace]")?.textContent?.trim() ?? "";
    return {
      ok: modelCalls.some((call) => call.model === expectedModel && call.tokensIn > 0 && call.tokensOut > 0)
        && tools.some((tool) => tool.name === "check_tank")
        && guard !== null,
      modelCalls,
      tools,
      guard,
      trace,
    };
  }, model);

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  await context.close();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
