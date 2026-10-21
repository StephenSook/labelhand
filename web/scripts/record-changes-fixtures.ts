// Records the label time machine's two API answers from live EPA data, as end-to-end fixtures: the PPLS version
// list and the text comparison for each shipped label's default pair, built by the same functions the routes call.
// Run from web/: pnpm exec tsx scripts/record-changes-fixtures.ts
// Writes web/tests/fixtures/changes/*.json, each with the time it was read.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { diffLabelVersions, labelVersions } from "../src/lib/label-versions";

const OUT = path.join(process.cwd(), "tests", "fixtures", "changes");
// Each shipped label against the version EPA accepted before it, the pair the page opens on.
const PAIRS: Array<[string, string, string]> = [
  ["228-653", "000228-00653-20210127.pdf", "000228-00653-20210514.pdf"],
  ["228-659", "000228-00659-20200131.pdf", "000228-00659-20220808.pdf"],
  ["5481-504", "005481-00504-20250227.pdf", "005481-00504-20260304.pdf"],
];

await mkdir(OUT, { recursive: true });
for (const [reg, from, to] of PAIRS) {
  const versions = await labelVersions(reg);
  await writeFile(path.join(OUT, `versions-${reg}.json`), `${JSON.stringify(versions, null, 1)}\n`);
  // PPLS limits bursts from one address.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const diff = await diffLabelVersions(reg, from, to);
  await writeFile(path.join(OUT, `diff-${reg}.json`), `${JSON.stringify({ recorded_utc: new Date().toISOString(), ...diff }, null, 1)}\n`);
  console.log(`${reg}: ${versions.versions.length} versions; ${diff.diff.changes.length} changes, unreadable ${diff.diff.unreadable}`);
}
