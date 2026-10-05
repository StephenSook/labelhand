import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

const engineSource = path.join(repoRoot, "core", "pkg");
const engineTarget = path.join(webRoot, "src", "engine", "pkg");
const publicData = path.join(webRoot, "public", "data");

const engineFiles = [
  "labelhand_core.js",
  "labelhand_core_bg.wasm",
  "labelhand_core.d.ts",
  "labelhand_core_bg.wasm.d.ts",
];
const registrations = ["5481-504", "264-700", "264-418"];
const replayPoints = ["tift", "worth", "colquitt"];

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyEngine() {
  await mkdir(engineTarget, { recursive: true });
  for (const file of engineFiles) {
    await copyFile(path.join(engineSource, file), path.join(engineTarget, file));
  }

  const wasm = await readFile(path.join(engineSource, "labelhand_core_bg.wasm"));
  await writeJson(path.join(webRoot, "src", "engine", "build-info.json"), {
    wasmBytes: wasm.byteLength,
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
  });
}

async function copyCompiledLabels() {
  const target = path.join(publicData, "compiled");
  await mkdir(target, { recursive: true });
  for (const reg of registrations) {
    const file = `${reg}.ship.json`;
    await copyFile(
      path.join(repoRoot, "data", "compiled", file),
      path.join(target, file),
    );
  }
}

async function writeLabelIndex() {
  const source = await readJson(path.join(repoRoot, "data", "labels", "index.json"));
  const labels = registrations.map((reg) => {
    const label = source[reg];
    if (!label) {
      throw new Error(`Label index has no entry for ${reg}`);
    }
    return {
      reg: label.reg,
      product: label.product,
      shortName: label.shortName,
      accepted: label.accepted,
      url: label.url,
      bytes: label.bytes,
      sha256: label.sha256,
    };
  });
  await writeJson(path.join(publicData, "labels", "index.json"), labels);
}

async function writePointCache() {
  const source = await readJson(path.join(repoRoot, "data", "nws_points_cache.json"));
  const points = Object.entries(source).map(([name, point]) => ({
    name,
    lat: point.lat,
    lon: point.lon,
    forecastHourly: point.forecastHourly,
  }));
  await writeJson(path.join(publicData, "nws_points_cache.json"), points);
}

async function writeReplayForecasts() {
  for (const point of replayPoints) {
    const source = await readJson(
      path.join(repoRoot, "tests", "fixtures", "engine", `${point}.json`),
    );
    await writeJson(path.join(publicData, "replay", `${point}.json`), {
      forecast_fetched_utc: source.forecast_fetched_utc,
      periods: source.periods,
    });
  }
}

async function copyEvalResult() {
  const target = path.join(publicData, "eval");
  await mkdir(target, { recursive: true });
  await copyFile(
    path.join(repoRoot, "eval", "results", "ship.json"),
    path.join(target, "ship.json"),
  );
}

await copyEngine();
await copyCompiledLabels();
await writeLabelIndex();
await writePointCache();
await writeReplayForecasts();
await copyEvalResult();

console.log("Synced the Rust WASM engine, labels, points, replay forecasts, and ship evaluation.");
