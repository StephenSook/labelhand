import { createHash } from "node:crypto";

export const FEDERAL_REG_PATTERN = /^\d{1,6}-\d{1,5}$/;
export const PPLS_FILE_PATTERN = /^(\d{6})-(\d{5})-(\d{8})\.pdf$/;
export const MIN_PDF_BYTES = 20_000;
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

const PPLS_API = "https://ordspub.epa.gov/ords/pesticides/cswu";
const PDF_BASE = "https://www3.epa.gov/pesticides/chem_search/ppls";
const USER_AGENT = "labelhand (github.com/StephenSook/labelhand)";
const REQUEST_TIMEOUT_MS = 15_000;

export interface ProductSearchResult {
  reg: string;
  product: string;
  alternateBrandNames: string[];
}

export interface PplsLabelVersion {
  reg: string;
  fileName: string;
  accepted: string;
  url: string;
}

export interface PplsProduct {
  reg: string;
  product: string;
  status: string;
  alternateBrandNames: string[];
  versions: PplsLabelVersion[];
}

export interface FetchedLabelPdf {
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  url: string;
}

export class PplsError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "PplsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function alternateBrandNames(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((name) => name.replaceAll('"', "").trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry.trim()].filter(Boolean);
    if (!isRecord(entry)) return [];
    const candidate = Object.entries(entry).find(([key, item]) => key.toLowerCase().includes("brand") && typeof item === "string");
    return candidate && typeof candidate[1] === "string" ? [candidate[1].trim()] : [];
  });
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new PplsError(`${what} returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502);
  }
  try {
    const payload = await response.json() as unknown;
    if (!isRecord(payload)) throw new TypeError("response is not an object");
    return payload;
  } catch {
    throw new PplsError(`${what} did not return valid JSON.`);
  }
}

async function requestJson(url: string, what: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new PplsError(`${what} could not be reached.`);
  }
  return readJson(response, what);
}

export function assertFederalReg(reg: string): string {
  const normalized = reg.trim();
  if (!FEDERAL_REG_PATTERN.test(normalized)) {
    throw new PplsError("Use a federal EPA registration number such as 100-1256. State SLN numbers are not supported.", 400);
  }
  return normalized;
}

export function parsePplsFileName(fileName: string, reg: string): { accepted: string } {
  const match = PPLS_FILE_PATTERN.exec(fileName);
  if (!match) throw new PplsError(`PPLS returned an invalid label file name for ${reg}.`);
  const [company, product] = assertFederalReg(reg).split("-").map(Number);
  if (Number(match[1]) !== company || Number(match[2]) !== product) {
    throw new PplsError(`PPLS returned a label file that does not match registration ${reg}.`);
  }
  const date = match[3];
  return { accepted: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` };
}

export function pplsPdfUrl(fileName: string): string {
  if (!PPLS_FILE_PATTERN.test(fileName)) throw new PplsError("PPLS returned an invalid label file name.");
  return `${PDF_BASE}/${fileName}`;
}

export async function searchProducts(query: string, fetchImpl: typeof fetch = fetch): Promise<ProductSearchResult[]> {
  const value = query.trim();
  if (value.length < 3) throw new PplsError("Search terms must contain at least 3 characters.", 400);
  const payload = await requestJson(
    `${PPLS_API}/ProductSearch/partialprodsearch/v2/riname/${encodeURIComponent(value)}`,
    "EPA product search",
    fetchImpl,
  );
  const items = Array.isArray(payload.items) ? payload.items : [];
  const seen = new Set<string>();
  const results: ProductSearchResult[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const reg = asString(item.eparegno);
    const product = asString(item.productname);
    if (!FEDERAL_REG_PATTERN.test(reg) || item.product_status !== "Active" || !product || seen.has(reg)) continue;
    seen.add(reg);
    results.push({
      reg,
      product,
      alternateBrandNames: alternateBrandNames(item.altrntbrndnames),
    });
    if (results.length === 20) break;
  }
  return results;
}

export async function listLabelVersions(reg: string, fetchImpl: typeof fetch = fetch): Promise<PplsProduct> {
  const normalizedReg = assertFederalReg(reg);
  const payload = await requestJson(`${PPLS_API}/ppls/${normalizedReg}`, `EPA label list for ${normalizedReg}`, fetchImpl);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const item = items.find((candidate) => isRecord(candidate) && candidate.eparegno === normalizedReg);
  if (!isRecord(item)) throw new PplsError(`EPA PPLS did not return registration ${normalizedReg}.`, 404);

  const files = Array.isArray(item.pdffiles) ? item.pdffiles : [];
  const versions: PplsLabelVersion[] = [];
  for (const entry of files) {
    if (!isRecord(entry)) continue;
    const fileName = asString(entry.pdffile);
    if (!fileName) continue;
    let accepted: string;
    try {
      ({ accepted } = parsePplsFileName(fileName, normalizedReg));
    } catch {
      continue;
    }
    versions.push({ reg: normalizedReg, fileName, accepted, url: pplsPdfUrl(fileName) });
  }
  versions.sort((left, right) => right.accepted.localeCompare(left.accepted));
  if (versions.length === 0) throw new PplsError(`EPA PPLS listed no matching label PDFs for ${normalizedReg}.`, 404);

  return {
    reg: normalizedReg,
    product: asString(item.productname),
    status: asString(item.product_status),
    alternateBrandNames: alternateBrandNames(item.altbrandnames),
    versions,
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fetchLabelPdf(
  version: PplsLabelVersion,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedLabelPdf> {
  parsePplsFileName(version.fileName, version.reg);
  const url = pplsPdfUrl(version.fileName);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/pdf" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new PplsError(`The EPA label PDF for ${version.reg} could not be reached.`);
  }
  if (!response.ok) throw new PplsError(`The EPA label PDF for ${version.reg} returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    throw new PplsError(`The EPA label PDF for ${version.reg} exceeds the ${MAX_PDF_BYTES} byte limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MIN_PDF_BYTES) {
    throw new PplsError(`The EPA label PDF for ${version.reg} was only ${bytes.byteLength} bytes.`);
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PplsError(`The EPA label PDF for ${version.reg} exceeds the ${MAX_PDF_BYTES} byte limit.`);
  }
  if (new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new PplsError(`The EPA response for ${version.reg} was not a PDF. The %PDF- signature was missing.`);
  }
  return { bytes, byteLength: bytes.byteLength, sha256: sha256(bytes), url };
}
