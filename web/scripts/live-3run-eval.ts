import { access, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileLiveLabel, PIPELINE_VERSION } from "../src/lib/compiler/pipeline";
import { fetchLabelPdf, listLabelVersions } from "../src/lib/ppls";

const REGISTRATION = "100-1256";
const OUTPUT = fileURLToPath(new URL("../../eval/results/live-3run-2026-10-19.json", import.meta.url));
const TEMP_OUTPUT = `${OUTPUT}.partial`;
const DEADLINE_MS = 150_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function splitPattern(vote: Record<string, number>): string {
  return Object.entries(vote)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([modality, count]) => `${modality}:${count}`)
    .join("|");
}

async function main(): Promise<void> {
  if (await exists(OUTPUT) || await exists(TEMP_OUTPUT)) {
    throw new Error(`Refusing a second paid measurement because ${OUTPUT} or its partial file already exists.`);
  }
  const apiKey = process.env.NEBIUS_API_KEY?.trim();
  if (!apiKey) throw new Error("NEBIUS_API_KEY is required.");

  const product = await listLabelVersions(REGISTRATION);
  const version = product.versions[0];
  if (!version) throw new Error(`EPA PPLS listed no label versions for ${REGISTRATION}.`);
  const pdf = await fetchLabelPdf(version);

  const started = performance.now();
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
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  const wallTimeMs = Math.round(performance.now() - started);

  if (compiled.readings !== 3 || compiled.reading_records.length !== 3 || !compiled.complete) {
    throw new Error("The paid measurement did not return three complete readings.");
  }

  const foundInReadings = { "1": 0, "2": 0, "3": 0 };
  const splitPatterns: Record<string, number> = {};
  const splitRules: Array<Record<string, unknown>> = [];
  for (const rule of compiled.accepted) {
    const found = String(rule.found_in_runs.length) as keyof typeof foundInReadings;
    foundInReadings[found] += 1;
    if (Object.keys(rule.modality_vote).length <= 1) continue;
    const pattern = splitPattern(rule.modality_vote);
    splitPatterns[pattern] = (splitPatterns[pattern] ?? 0) + 1;
    splitRules.push({
      id: rule.id,
      page: rule.page,
      param: rule.param,
      winning_modality: rule.modality,
      found_in_runs: rule.found_in_runs,
      modality_by_run: rule.modality_by_run,
      modality_vote: rule.modality_vote,
    });
  }

  const receipt = {
    schema_version: 1,
    measurement: "live-three-reading-compile",
    measured_utc: new Date().toISOString(),
    source: {
      registration: REGISTRATION,
      product: product.product,
      accepted: version.accepted,
      file_name: version.fileName,
      label_url: version.url,
      label_sha256: pdf.sha256,
      label_bytes: pdf.byteLength,
    },
    pipeline_version: PIPELINE_VERSION,
    summary: {
      readings: compiled.readings,
      reading_metrics: Object.fromEntries(compiled.reading_records.map((record) => [String(record.reading), {
        attempts: record.attempts,
        accepted_rules: record.accepted_rules,
        rejected_rules: record.rejected_rules,
        latency_ms: record.latency_ms,
        total_tokens: record.total_tokens,
        cost_usd: Number(record.cost_usd.toFixed(7)),
      }])),
      reading_rule_counts: compiled.reading_records.map((record) => ({
        reading: record.reading,
        attempts: record.attempts,
        accepted_rules: record.accepted_rules,
        rejected_rules: record.rejected_rules,
        latency_ms: record.latency_ms,
        tokens_in: record.tokens_in,
        tokens_out: record.tokens_out,
        total_tokens: record.total_tokens,
        cost_usd: record.cost_usd,
        request_ids: record.request_ids,
      })),
      merge: {
        merged_rule_count: compiled.accepted.length,
        found_in_readings: foundInReadings,
      },
      modality_splits: {
        rules_with_split: splitRules.length,
        patterns: splitPatterns,
        rules: splitRules,
      },
      totals: {
        wall_time_ms: wallTimeMs,
        pipeline_latency_ms: compiled.latency_ms,
        tokens_in: compiled.tokens_in,
        tokens_out: compiled.tokens_out,
        total_tokens: compiled.total_tokens,
        cost_usd: compiled.cost_usd,
        request_ids: compiled.request_ids,
      },
    },
  };

  await writeFile(TEMP_OUTPUT, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(TEMP_OUTPUT, OUTPUT);
  process.stdout.write(`${JSON.stringify(receipt.summary)}\n`);
}

await main();
