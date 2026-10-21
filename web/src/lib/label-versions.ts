import { extractPdfText } from "@/lib/compiler/pdf-text";
import { diffLabelText, type LabelTextDiff } from "@/lib/label-diff";
import {
  assertFederalReg,
  fetchLabelPdf,
  listLabelVersions,
  parsePplsFileName,
  pplsPdfUrl,
  PplsError,
  type PplsLabelVersion,
} from "@/lib/ppls";

// EPA PPLS throttles bursts from one address, so a version list is kept here and in the CDN (see the route's
// cache-control), and the last good list answers when PPLS does not.
export const VERSIONS_FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_REMEMBERED = 50;

export type LabelVersionList = {
  reg: string;
  product: string;
  status: string;
  cancelled: boolean;
  versions: Array<{ fileName: string; accepted: string; url: string }>;
  fetchedAt: string;
  // Set when PPLS did not answer and this is the last list this server read.
  stale?: { reason: string };
};

const versionMemory = new Map<string, LabelVersionList>();
const diffMemory = new Map<string, LabelVersionDiff>();

function remember<T>(memory: Map<string, T>, key: string, value: T): void {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MAX_REMEMBERED) memory.delete(memory.keys().next().value as string);
}

export function forgetLabelVersionsForTests(): void {
  versionMemory.clear();
  diffMemory.clear();
}

export function pplsUnavailableMessage(reg: string, cause: string): string {
  return `EPA's label system (PPLS) did not answer for EPA Reg. ${reg}, so the list of accepted label versions cannot be shown right now. PPLS limits bursts of requests; try again in a few minutes. (${cause})`;
}

export async function labelVersions(reg: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<LabelVersionList> {
  const normalized = assertFederalReg(reg);
  const known = versionMemory.get(normalized);
  if (known && !known.stale && now() - Date.parse(known.fetchedAt) < VERSIONS_FRESH_MS) return known;
  try {
    const product = await listLabelVersions(normalized, fetchImpl);
    const list: LabelVersionList = {
      reg: normalized,
      product: product.product,
      status: product.status,
      cancelled: product.cancelled,
      versions: product.versions.map(({ fileName, accepted, url }) => ({ fileName, accepted, url })),
      fetchedAt: new Date(now()).toISOString(),
    };
    remember(versionMemory, normalized, list);
    return list;
  } catch (error) {
    // A registration PPLS says it does not have is an answer, not an outage.
    if (error instanceof PplsError && (error.status === 404 || error.status === 400)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (known) return { ...known, stale: { reason } };
    throw new PplsError(pplsUnavailableMessage(normalized, reason), 503);
  }
}

export type DiffedVersion = { fileName: string; accepted: string; url: string; sha256: string; pages: number };

export type LabelVersionDiff = {
  reg: string;
  from: DiffedVersion;
  to: DiffedVersion;
  diff: LabelTextDiff;
};

function version(reg: string, fileName: string): PplsLabelVersion {
  const { accepted } = parsePplsFileName(fileName, reg);
  return { reg, fileName, accepted, url: pplsPdfUrl(fileName) };
}

// Two accepted versions of one label, compared sentence by sentence from their PDF text layers. An accepted PDF
// never changes under its file name (the name carries the acceptance date), so a result can be kept.
export async function diffLabelVersions(reg: string, fromFile: string, toFile: string, fetchImpl: typeof fetch = fetch): Promise<LabelVersionDiff> {
  const normalized = assertFederalReg(reg);
  const from = version(normalized, fromFile);
  const to = version(normalized, toFile);
  if (from.fileName === to.fileName) throw new PplsError("Choose two different label versions to compare.", 400);
  const key = `${from.fileName}|${to.fileName}`;
  const known = diffMemory.get(key);
  if (known) return known;
  const [fromPdf, toPdf] = await Promise.all([fetchLabelPdf(from, fetchImpl), fetchLabelPdf(to, fetchImpl)]);
  const [fromText, toText] = [await extractPdfText(fromPdf.bytes), await extractPdfText(toPdf.bytes)];
  const result: LabelVersionDiff = {
    reg: normalized,
    from: { fileName: from.fileName, accepted: from.accepted, url: from.url, sha256: fromPdf.sha256, pages: fromText.pageCount },
    to: { fileName: to.fileName, accepted: to.accepted, url: to.url, sha256: toPdf.sha256, pages: toText.pageCount },
    diff: diffLabelText(fromText.pages, toText.pages),
  };
  remember(diffMemory, key, result);
  return result;
}
