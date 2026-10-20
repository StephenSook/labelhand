// Records one real live compile of Axial XL (EPA Reg. 100-1256) as the NDJSON stream the
// browser receives, for the end-to-end tests that must not spend Token Factory credit.
// One paid three-reading compile, about $0.07. Run: pnpm exec tsx scripts/record-live-stream.ts

import { rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileLiveLabel, type PipelineEvent } from "../src/lib/compiler/pipeline";
import { fetchLabelPdf, listLabelVersions } from "../src/lib/ppls";

const REGISTRATION = "100-1256";
const OUTPUT = fileURLToPath(new URL("../tests/fixtures/live/axial-xl-100-1256.ndjson", import.meta.url));

async function main(): Promise<void> {
  const apiKey = process.env.NEBIUS_API_KEY?.trim();
  if (!apiKey) throw new Error("NEBIUS_API_KEY is required.");
  const product = await listLabelVersions(REGISTRATION);
  const version = product.versions[0];
  if (!version) throw new Error(`EPA PPLS listed no label versions for ${REGISTRATION}.`);
  const pdf = await fetchLabelPdf(version);

  const events: PipelineEvent[] = [
    { type: "listed", reg: REGISTRATION, product: product.product, fileName: version.fileName, accepted: version.accepted },
  ];
  const compiled = await compileLiveLabel({
    reg: REGISTRATION,
    product: product.product,
    alternateBrandNames: product.alternateBrandNames,
    fileName: version.fileName,
    accepted: version.accepted,
    labelUrl: version.url,
    labelSha256: pdf.sha256,
    pdfBytes: pdf.bytes,
    apiKey,
    signal: AbortSignal.timeout(150_000),
  }, (event) => {
    events.push(event);
  });
  if (compiled.readings !== 3 || !compiled.complete) throw new Error("The compile did not return three complete readings.");

  await writeFile(`${OUTPUT}.partial`, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await rename(`${OUTPUT}.partial`, OUTPUT);
  const counts = compiled.reading_records.map((record) => record.accepted_rules).join(", ");
  console.log(`${events.length} events; readings ${counts}; merged ${compiled.accepted.length}; $${compiled.cost_usd.toFixed(4)}`);
}

await main();
