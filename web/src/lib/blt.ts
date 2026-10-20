// Server-side check of EPA's Bulletins Live! Two (BLT) for one field point, a tank of EPA
// registrations, and an application month. EPA sends no CORS header on the BLT API, so the browser
// asks /api/bulletins and this module asks EPA.
//
// Upstream calls, each one called by hand and answered on 2026-10-20 (the request shapes are
// recorded with their responses in web/tests/fixtures/blt/sources.json):
//   1. BLT PULA map service, layer 0 "Effective Pulas": which PULAs contain the point.
//   2. BLT API /pulas_public: which PULAs carry a limitation for these registrations, effective
//      before the first day of the month after the application month. This is the filter the BLT
//      web app itself sends, including its null entry in the product list.
//   3. BLT API /limitations_public, only when 1 and 2 share a PULA: the limitation code and text.
// EPA states this data is informational and not a Bulletin. A "checked" answer is returned only
// when every call answered with something this module could fully read; otherwise "unavailable".
import {
  BULLETIN_REG_PATTERN,
  MAX_BULLETIN_REGS,
  canonicalRegistration,
  easternMonth,
  monthIndex,
  type BulletinCheck,
  type BulletinLimitation,
  type BulletinPula,
} from "./bulletins";

export const BLT_API = "https://blt.epa.gov/blt/api";
export const BLT_POINT_LAYER = "https://blt.epa.gov/arcgis/rest/services/BLT/PesticideUsageLimitationAreas/MapServer/0/query";
export const BLT_SOURCE = "EPA Bulletins Live! Two data services at blt.epa.gov (informational, not a Bulletin)";
export const BLT_UPSTREAM_TIMEOUT_MS = 8_000;
export const BLT_CACHE_SECONDS = 3 * 60 * 60;

// Positive controls. A "no limitations" answer counts only when both still return their known
// PULAs: a point in Ware County, GA inside PULAs 91, 96, 97 and 110, and STRYAX HERBICIDE
// (EPA Reg. No. 264-1241), limited in PULAs 111, 121, 122 and 123 (both checked 2026-10-20).
// They are asked again for every empty answer, never cached: an outage that empties the map for
// every point must not ride on a control that passed earlier.
export const CONTROL_POINT = { lat: 31.31097, lon: -82.43219 } as const;
export const CONTROL_REG = "264-1241";
export const CONTROL_POINT_PULAS = [91, 96, 97, 110] as const;
export const CONTROL_REG_PULAS = [111, 121, 122, 123] as const;

const USER_AGENT = "labelhand (github.com/StephenSook/labelhand)";
const POINT_FIELDS = "pula_id,core_pula_id,polygon_pula_id,event_name,effective_date";
const MAX_CACHE_ENTRIES = 500;

export type BulletinQuery = {
  lat: number;
  lon: number;
  regs: string[];
  month: string;
};

export class BltInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BltInputError";
  }
}

export class BltUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BltUpstreamError";
  }
}

type PointPula = BulletinPula & { core_pula_id: number | null; polygon_pula_id: number | null };

type CandidatePula = {
  pula_id: number;
  core_pula_id: number | null;
  effective_date: string;
  status: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function optionalInteger(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (!isInteger(value)) throw new BltUpstreamError(`${what} was not a whole number.`);
  return value;
}

function singleParam(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1) throw new BltInputError(`Give exactly one ${name} parameter.`);
  return values[0];
}

function coordinate(raw: string, name: string, limit: number): number {
  if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(raw)) throw new BltInputError(`${name} must be a decimal number of degrees.`);
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw new BltInputError(`${name} must be between -${limit} and ${limit}.`);
  return Number(value.toFixed(6));
}

function normalizeReg(reg: string): string {
  if (!BULLETIN_REG_PATTERN.test(reg)) throw new BltInputError(`${reg || "An empty value"} is not a federal EPA Reg. No. such as 264-700.`);
  return canonicalRegistration(reg);
}

export function parseBulletinQuery(params: URLSearchParams, now: Date = new Date()): BulletinQuery {
  const lat = coordinate(singleParam(params, "lat"), "lat", 90);
  const lon = coordinate(singleParam(params, "lon"), "lon", 180);
  const rawRegs = singleParam(params, "regs").split(",");
  if (rawRegs.length > MAX_BULLETIN_REGS) throw new BltInputError(`Give at most ${MAX_BULLETIN_REGS} EPA Reg. Nos.`);
  const regs = [...new Set(rawRegs.map(normalizeReg))].sort();
  const month = singleParam(params, "month");
  const requested = monthIndex(month);
  const current = monthIndex(easternMonth(now));
  if (requested === null) throw new BltInputError("month must look like 2026-11.");
  if (current === null || requested < current || requested > current + 6) {
    throw new BltInputError("month must be this month or one of the next six, the months Bulletins Live! Two offers.");
  }
  return { lat, lon, regs, month };
}

// The BLT web app filters on effective_date before the first day of the following month,
// written as month/day/year (EPA reads it as midnight Eastern).
export function firstOfNextMonth(month: string): string {
  const index = monthIndex(month);
  if (index === null) throw new BltInputError("month must look like 2026-11.");
  const next = index + 1;
  return `${(next % 12) + 1}/1/${Math.floor(next / 12)}`;
}

function bltUrl(path: string, params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, JSON.stringify(value));
  return `${BLT_API}/${path}?${search.toString()}`;
}

export function pointQueryUrl(lat: number, lon: number): string {
  const search = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: POINT_FIELDS,
    returnGeometry: "false",
    f: "json",
  });
  return `${BLT_POINT_LAYER}?${search.toString()}`;
}

export function candidatePulasUrl(regs: string[], month: string): string {
  return bltUrl("pulas_public", {
    where: {
      limitations: { product_registration_number: { in: [null, ...regs] } },
      effective_date: { "<": firstOfNextMonth(month) },
    },
    select: { pula_id: 1, core_pula_id: 1, effective_date: 1, status: 1 },
  });
}

export function limitationsUrl(pulaIds: number[], regs: string[]): string {
  return bltUrl("limitations_public", {
    where: {
      pula_id: { in: pulaIds },
      product_registration_number: { in: [null, ...regs] },
    },
    select: { limitation_id: 1, pula_id: 1, code: 1, product_registration_number: 1, limitation: 1 },
  });
}

async function fetchJson(url: string, what: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(BLT_UPSTREAM_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new BltUpstreamError(`${what} did not answer within ${BLT_UPSTREAM_TIMEOUT_MS / 1000} seconds.`);
  }
  if (!response.ok) throw new BltUpstreamError(`${what} returned HTTP ${response.status}.`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new BltUpstreamError(`${what} did not return readable JSON.`);
  }
}

// The PULA map answers errors with HTTP 200 and an "error" object, and a geometry it cannot read
// makes it return every PULA with exceededTransferLimit set (both seen 2026-10-20).
export function parsePointPulas(payload: unknown): PointPula[] {
  const what = "The BLT PULA map";
  if (!isRecord(payload)) throw new BltUpstreamError(`${what} did not return an object.`);
  if ("error" in payload) {
    const message = isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : "an error";
    throw new BltUpstreamError(`${what} answered with ${message}`);
  }
  if (payload.exceededTransferLimit === true) throw new BltUpstreamError(`${what} returned a truncated feature list.`);
  if (!Array.isArray(payload.features)) throw new BltUpstreamError(`${what} returned no feature list.`);
  const byId = new Map<number, PointPula>();
  for (const feature of payload.features) {
    const attributes = isRecord(feature) ? feature.attributes : undefined;
    if (!isRecord(attributes) || !isInteger(attributes.pula_id)) throw new BltUpstreamError(`${what} returned a feature without a PULA id.`);
    const effective = attributes.effective_date;
    if (effective !== null && effective !== undefined && !isInteger(effective)) {
      throw new BltUpstreamError(`${what} returned an unreadable effective date for PULA ${attributes.pula_id}.`);
    }
    byId.set(attributes.pula_id, {
      pula_id: attributes.pula_id,
      core_pula_id: optionalInteger(attributes.core_pula_id, `${what} core_pula_id`),
      polygon_pula_id: optionalInteger(attributes.polygon_pula_id, `${what} polygon_pula_id`),
      event_name: typeof attributes.event_name === "string" ? attributes.event_name : "",
      effective_date: isInteger(effective) ? new Date(effective).toISOString() : null,
    });
  }
  return [...byId.values()].sort((left, right) => left.pula_id - right.pula_id);
}

export function parseCandidatePulas(payload: unknown): CandidatePula[] {
  const what = "BLT pulas_public";
  if (!Array.isArray(payload)) throw new BltUpstreamError(`${what} did not return a list.`);
  return payload.map((row) => {
    if (!isRecord(row) || !isInteger(row.pula_id)) throw new BltUpstreamError(`${what} returned a row without a PULA id.`);
    if (typeof row.effective_date !== "string" || Number.isNaN(Date.parse(row.effective_date))) {
      throw new BltUpstreamError(`${what} returned an unreadable effective date for PULA ${row.pula_id}.`);
    }
    if (typeof row.status !== "string") throw new BltUpstreamError(`${what} returned no status for PULA ${row.pula_id}.`);
    return {
      pula_id: row.pula_id,
      core_pula_id: optionalInteger(row.core_pula_id, `${what} core_pula_id`),
      effective_date: row.effective_date,
      status: row.status,
    };
  });
}

// EPA's limitation text carries inline HTML (bold spans, Mitigation Menu links). The card shows
// it as plain text.
export function plainLimitationText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return entities[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

// BLT ignores a where field it does not know and returns every row (seen 2026-10-20), so every row
// must match the filter this module sent, or the answer is not trusted.
export function parseLimitations(payload: unknown, pulaIds: Set<number>, regs: Set<string>): BulletinLimitation[] {
  const what = "BLT limitations_public";
  if (!Array.isArray(payload)) throw new BltUpstreamError(`${what} did not return a list.`);
  const seen = new Set<string>();
  const limitations: BulletinLimitation[] = [];
  for (const row of payload) {
    if (!isRecord(row) || !isInteger(row.pula_id)) throw new BltUpstreamError(`${what} returned a row without a PULA id.`);
    if (!pulaIds.has(row.pula_id)) throw new BltUpstreamError(`${what} returned PULA ${row.pula_id}, which was not asked for.`);
    const reg = row.product_registration_number;
    if (reg === null || reg === undefined || reg === "") {
      throw new BltUpstreamError(`${what} lists a limitation in PULA ${row.pula_id} that names no product.`);
    }
    if (typeof reg !== "string" || !regs.has(reg)) throw new BltUpstreamError(`${what} returned a product that was not asked for.`);
    if (typeof row.code !== "string" || !row.code.trim()) throw new BltUpstreamError(`${what} returned a limitation without a code.`);
    if (typeof row.limitation !== "string" || !plainLimitationText(row.limitation)) {
      throw new BltUpstreamError(`${what} returned limitation ${row.code} without text.`);
    }
    // PULA 121 lists DC125 twice for STRYAX with the same text under two limitation ids (one per
    // use), so rows are merged on what the card shows.
    const limitation = { pula_id: row.pula_id, code: row.code.trim(), text: plainLimitationText(row.limitation), reg };
    const key = JSON.stringify([limitation.pula_id, limitation.reg, limitation.code, limitation.text]);
    if (seen.has(key)) continue;
    seen.add(key);
    limitations.push(limitation);
  }
  return limitations.sort((left, right) => (
    left.reg.localeCompare(right.reg) || left.pula_id - right.pula_id || left.code.localeCompare(right.code)
  ));
}

async function pointPulas(lat: number, lon: number, fetchImpl: typeof fetch): Promise<PointPula[]> {
  return parsePointPulas(await fetchJson(pointQueryUrl(lat, lon), "The BLT PULA map", fetchImpl));
}

async function candidatePulas(regs: string[], month: string, fetchImpl: typeof fetch): Promise<CandidatePula[]> {
  return parseCandidatePulas(await fetchJson(candidatePulasUrl(regs, month), "BLT pulas_public", fetchImpl));
}

// Both controls must return every PULA they are known to have. A non-empty answer that lacks them
// is as untrustworthy as an empty one.
async function controlsPass(month: string, fetchImpl: typeof fetch): Promise<boolean> {
  const [point, product] = await Promise.all([
    pointPulas(CONTROL_POINT.lat, CONTROL_POINT.lon, fetchImpl),
    candidatePulas([CONTROL_REG], month, fetchImpl),
  ]);
  const pointIds = new Set(point.map((pula) => pula.pula_id));
  const productIds = new Set(product.map((pula) => pula.pula_id));
  return CONTROL_POINT_PULAS.every((id) => pointIds.has(id)) && CONTROL_REG_PULAS.every((id) => productIds.has(id));
}

function unavailable(reason: string): BulletinCheck {
  return { status: "unavailable", reason };
}

export async function checkBulletins(
  query: BulletinQuery,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<BulletinCheck> {
  try {
    const [point, candidates] = await Promise.all([
      pointPulas(query.lat, query.lon, fetchImpl),
      candidatePulas(query.regs, query.month, fetchImpl),
    ]);

    // The point query reads the map of effective PULAs only. A PULA for these products that is not
    // yet effective cannot be placed on that map, so the answer is left to Bulletins Live! Two.
    const pending = candidates.find((candidate) => (
      candidate.status !== "effective" || Date.parse(candidate.effective_date) > now.getTime()
    ));
    if (pending) {
      return unavailable(`EPA lists PULA ${pending.pula_id} for these products with status ${pending.status}, effective ${pending.effective_date.slice(0, 10)}; its area is not on the effective map yet.`);
    }

    const pointIds = new Set<number>();
    for (const pula of point) {
      pointIds.add(pula.pula_id);
      if (pula.core_pula_id !== null) pointIds.add(pula.core_pula_id);
      if (pula.polygon_pula_id !== null) pointIds.add(pula.polygon_pula_id);
    }
    const matched = [...new Set(candidates
      .filter((candidate) => pointIds.has(candidate.pula_id) || (candidate.core_pula_id !== null && pointIds.has(candidate.core_pula_id)))
      .map((candidate) => candidate.pula_id))].sort((left, right) => left - right);

    const pulas = point.map(({ pula_id, event_name, effective_date }) => ({ pula_id, event_name, effective_date }));
    const checked = (limitations: BulletinLimitation[]): BulletinCheck => ({
      status: "checked",
      pulas,
      limitations,
      checkedAt: now.toISOString(),
      source: BLT_SOURCE,
    });

    if (matched.length === 0) {
      if (!await controlsPass(query.month, fetchImpl)) {
        return unavailable("EPA's control point or control product did not return its known PULAs, so an empty answer here cannot be trusted.");
      }
      return checked([]);
    }

    const limitations = parseLimitations(
      await fetchJson(limitationsUrl(matched, query.regs), "BLT limitations_public", fetchImpl),
      new Set(matched),
      new Set(query.regs),
    );
    const missing = matched.find((id) => !limitations.some((limitation) => limitation.pula_id === id));
    if (missing !== undefined) {
      return unavailable(`EPA lists PULA ${missing} for these products but returned no limitation text for it.`);
    }
    return checked(limitations);
  } catch (error) {
    if (error instanceof BltUpstreamError || error instanceof BltInputError) return unavailable(error.message);
    return unavailable("The Bulletins Live! Two check failed.");
  }
}

const answers = new Map<string, { expires: number; value: BulletinCheck }>();

export function bulletinCacheKey(query: BulletinQuery): string {
  return `${query.lat},${query.lon}|${query.regs.join(",")}|${query.month}`;
}

// Only complete answers are cached; an unavailable answer is asked again on the next request.
export async function checkBulletinsCached(
  query: BulletinQuery,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<BulletinCheck> {
  const key = bulletinCacheKey(query);
  const cached = answers.get(key);
  if (cached && cached.expires > now.getTime()) return cached.value;
  if (cached) answers.delete(key);
  const value = await checkBulletins(query, fetchImpl, now);
  if (value.status === "checked") {
    if (answers.size >= MAX_CACHE_ENTRIES) {
      const oldest = answers.keys().next().value;
      if (oldest !== undefined) answers.delete(oldest);
    }
    answers.set(key, { expires: now.getTime() + BLT_CACHE_SECONDS * 1000, value });
  }
  return value;
}

export function clearBulletinCache(): void {
  answers.clear();
}
