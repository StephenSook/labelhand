import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import labelIndex from "../../../../../public/data/labels/index.json";

export const runtime = "nodejs";
export const maxDuration = 25;

const USER_AGENT = "labelhand (github.com/StephenSook/labelhand)";
const TIMEOUT_MS = 20_000;

type LabelRecord = (typeof labelIndex)[number];

function plain(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function findLabel(reg: string): LabelRecord | undefined {
  return labelIndex.find((label) => label.reg === reg);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ reg: string }> },
) {
  const { reg } = await context.params;
  const label = findLabel(reg);
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

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (signature !== "%PDF-") {
    return plain(`The EPA response for ${reg} was not a PDF. The %PDF- signature was missing.`, 502);
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== label.sha256) {
    return plain(`The EPA PDF SHA-256 for ${reg} did not match the committed label index.`, 502);
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
