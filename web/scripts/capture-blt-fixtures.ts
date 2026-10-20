// Records real Bulletins Live! Two responses as unit-test fixtures, each fetched with the URL the
// route itself builds. Run from web/: pnpm exec tsx scripts/capture-blt-fixtures.ts
// Writes web/tests/fixtures/blt/*.json and sources.json (URL, HTTP status, and time of each fetch).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BLT_API,
  BLT_POINT_LAYER,
  CONTROL_POINT,
  CONTROL_REG,
  candidatePulasUrl,
  limitationsUrl,
  pointQueryUrl,
} from "../src/lib/blt";

const OUT = path.join(process.cwd(), "tests", "fixtures", "blt");
const MONTH = "2026-11";
const TANK = ["264-418", "264-700", "5481-504"];
// A point inside PULA 121 (Dicamba 2026) in Dooly County, GA, picked from the PULA's own polygon.
const DOOLY_PULA_121 = { lat: 32.21361, lon: -83.73173 };

type Capture = {
  file: string;
  url: string;
  note: string;
  // Real responses that are too long to keep whole are cut to their first rows; the cut is noted.
  keep?: (body: unknown) => unknown;
};

function firstRows(count: number) {
  return (body: unknown) => {
    if (Array.isArray(body)) return body.slice(0, count);
    if (body && typeof body === "object" && Array.isArray((body as { features?: unknown }).features)) {
      const record = body as Record<string, unknown> & { features: unknown[] };
      return { ...record, features: record.features.slice(0, count) };
    }
    return body;
  };
}

const captures: Capture[] = [
  { file: "point-tift.json", url: pointQueryUrl(31.4, -83.6), note: "Labelhand tift field point: no PULA contains it." },
  { file: "point-ware-control.json", url: pointQueryUrl(CONTROL_POINT.lat, CONTROL_POINT.lon), note: "Control point in Ware County: inside PULAs 91, 96, 97 and 110." },
  { file: "point-dooly-pula-121.json", url: pointQueryUrl(DOOLY_PULA_121.lat, DOOLY_PULA_121.lon), note: "A point inside PULA 121 (Dicamba 2026) in Dooly County." },
  { file: "candidates-labelhand-tank-2026-11.json", url: candidatePulasUrl(TANK, MONTH), note: "Folex 6 EC, Dropp SC and Prep for November 2026: no PULA lists them." },
  { file: "candidates-stryax-2026-11.json", url: candidatePulasUrl([CONTROL_REG], MONTH), note: "Control product STRYAX HERBICIDE for November 2026: PULAs 111, 121, 122 and 123." },
  { file: "limitations-stryax-pula-121.json", url: limitationsUrl([121], [CONTROL_REG]), note: "STRYAX limitations inside PULA 121." },
  {
    file: "point-error-unknown-field.json",
    url: `${BLT_POINT_LAYER}?${new URLSearchParams({ geometry: "-83.6,31.4", geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "pula_idX", returnGeometry: "false", f: "json" })}`,
    note: "The PULA map answers a query error with HTTP 200 and an error object.",
  },
  {
    file: "point-truncated-bad-geometry.json",
    url: `${BLT_POINT_LAYER}?${new URLSearchParams({ geometry: "abc", geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "pula_id", returnGeometry: "false", f: "json" })}`,
    note: "An unreadable geometry makes the PULA map return every PULA with exceededTransferLimit true. Kept: first 3 features.",
    keep: firstRows(3),
  },
  {
    file: "limitations-ignored-filter.json",
    url: `${BLT_API}/limitations_public?${new URLSearchParams({ where: JSON.stringify({ product_registration_numberX: CONTROL_REG }), select: JSON.stringify({ limitation_id: 1, pula_id: 1, code: 1, product_registration_number: 1, limitation: 1 }) })}`,
    note: "BLT ignores an unknown where field and returns every limitation. Kept: first 2 rows.",
    keep: firstRows(2),
  },
  {
    file: "limitations-invalid-where-400.json",
    url: `${BLT_API}/limitations_public?where=%7Bbad`,
    note: "BLT answers a where that is not JSON with HTTP 400.",
  },
];

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, {
        headers: { accept: "application/json", "user-agent": "labelhand (github.com/StephenSook/labelhand)" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const sources: Record<string, { url: string; http_status: number; fetched_utc: string; note: string }> = {};
  for (const capture of captures) {
    const response = await fetchWithRetry(capture.url);
    const fetchedUtc = new Date().toISOString();
    const body = await response.json() as unknown;
    const kept = capture.keep ? capture.keep(body) : body;
    await writeFile(path.join(OUT, capture.file), `${JSON.stringify(kept, null, 2)}\n`, "utf8");
    sources[capture.file] = { url: capture.url, http_status: response.status, fetched_utc: fetchedUtc, note: capture.note };
    console.log(`${response.status} ${capture.file}`);
  }
  await writeFile(path.join(OUT, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
