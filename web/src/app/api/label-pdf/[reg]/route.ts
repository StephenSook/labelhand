import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import labelIndex from "../../../../../public/data/labels/index.json";

import { getCachedLiveLabel, getRegistrationCacheIndex } from "@/lib/live-cache";
import { assertCacheHitAllowed, LiveLimitError } from "@/lib/live-limits";
import { assertFederalReg, MAX_PDF_BYTES, parsePplsFileName, pplsPdfUrl } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 25;

const USER_AGENT = "labelhand (github.com/StephenSook/labelhand)";
const TIMEOUT_MS = 20_000;

type LabelRecord = (typeof labelIndex)[number];

interface LabelSource {
  url: string;
  sha256: string;
  digestSource: "committed label index" | "live cache record" | "label comparison";
}

function plain(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function findLabel(reg: string): LabelRecord | undefined {
  return labelIndex.find((label) => label.reg === reg);
}

// Any accepted version of this registration, by its PPLS file name, held to the SHA-256 the label comparison
// read: the page shown is the same PDF whose text was compared.
function requestedVersion(reg: string, file: string, sha256: string): LabelSource | { error: string } {
  try {
    parsePplsFileName(file, assertFederalReg(reg));
  } catch {
    return { error: `${file} is not an EPA PPLS label file of registration ${reg}.` };
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) return { error: "A label version needs the SHA-256 of the PDF that was compared." };
  return { url: pplsPdfUrl(file), sha256, digestSource: "label comparison" };
}

async function findLiveLabel(reg: string, signal: AbortSignal): Promise<LabelSource | null> {
  try {
    assertFederalReg(reg);
    const index = await getRegistrationCacheIndex(reg, signal);
    if (!index) return null;
    const expectedUrl = pplsPdfUrl(index.fileName);
    if (index.labelUrl !== expectedUrl) return null;
    const compiled = await getCachedLiveLabel(index.sha256, index.pipelineVersion, signal);
    if (!compiled
      || compiled.reg !== reg
      || compiled.product !== index.product
      || compiled.label_file !== index.fileName
      || compiled.label_accepted !== index.accepted
      || compiled.label_url !== expectedUrl
      || compiled.label_sha256 !== index.sha256) {
      return null;
    }
    return {
      url: expectedUrl,
      sha256: index.sha256,
      digestSource: "live cache record",
    };
  } catch {
    return null;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ reg: string }> },
) {
  const { reg } = await context.params;
  const query = new URL(request.url).searchParams;
  const version = query.has("file") ? requestedVersion(reg, query.get("file") ?? "", query.get("sha256") ?? "") : null;
  if (version && "error" in version) return plain(version.error, 400);
  if (version) {
    // A named version can be any accepted PDF of the registration, so it shares the per-address label request limit.
    try {
      assertCacheHitAllowed(clientIp(request));
    } catch (error) {
      if (!(error instanceof LiveLimitError)) throw error;
      const limited = plain(error.message, error.status);
      limited.headers.set("retry-after", String(error.retryAfterSeconds ?? 60));
      return limited;
    }
  }
  const committed = version ? undefined : findLabel(reg);
  const label: LabelSource | null = version
    ? version
    : committed
    ? {
        url: committed.url,
        sha256: committed.sha256,
        digestSource: "committed label index",
      }
    : await findLiveLabel(reg, request.signal);
  if (!label) return plain(`No accepted EPA label is indexed for registration ${reg}.`, 404);

  let upstream: Response;
  try {
    upstream = await fetch(label.url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return plain(
      timedOut
        ? `The EPA label fetch for ${reg} exceeded 20 seconds.`
        : `The EPA label fetch for ${reg} could not be completed.`,
      502,
    );
  }

  if (!upstream.ok) {
    return plain(`The EPA label fetch for ${reg} returned HTTP ${upstream.status}.`, 502);
  }

  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    return plain(`The EPA label PDF for ${reg} exceeds the ${MAX_PDF_BYTES} byte limit.`, 502);
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return plain(`The EPA label PDF for ${reg} exceeds the ${MAX_PDF_BYTES} byte limit.`, 502);
  }
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (signature !== "%PDF-") {
    return plain(`The EPA response for ${reg} was not a PDF. The %PDF- signature was missing.`, 502);
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== label.sha256) {
    return plain(`The EPA PDF SHA-256 for ${reg} did not match the ${label.digestSource}.`, 502);
  }

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.byteLength),
      "cache-control": "public, s-maxage=604800, stale-while-revalidate=86400",
    },
  });
}
