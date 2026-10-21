import { NextRequest, NextResponse } from "next/server";

import { diffLabelVersions } from "@/lib/label-versions";
import { PplsError } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const reg = params.get("reg") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  try {
    const result = await diffLabelVersions(reg, from, to);
    return NextResponse.json(result, {
      // An accepted label PDF never changes under its file name, so neither does the comparison of two of them.
      headers: { "cache-control": "public, s-maxage=604800, stale-while-revalidate=2592000" },
    });
  } catch (error) {
    const status = error instanceof PplsError ? error.status : 502;
    const message = error instanceof PplsError
      ? error.message
      : "The two EPA label PDFs could not be read, so their text cannot be compared right now.";
    return NextResponse.json({ error: message, status }, { status, headers: { "cache-control": "no-store" } });
  }
}
