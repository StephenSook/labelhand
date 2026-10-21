import { NextResponse } from "next/server";

import { labelVersions } from "@/lib/label-versions";
import { PplsError } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(_request: Request, context: { params: Promise<{ reg: string }> }) {
  const { reg } = await context.params;
  try {
    const list = await labelVersions(reg);
    return NextResponse.json(list, {
      headers: {
        // A fresh list is shared for six hours; a stale one only briefly, so the next visitor asks PPLS again.
        "cache-control": list.stale ? "public, s-maxage=60" : "public, s-maxage=21600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    const status = error instanceof PplsError ? error.status : 502;
    const message = error instanceof Error ? error.message : "EPA's label system (PPLS) could not be read.";
    return NextResponse.json({ error: message, status }, { status, headers: { "cache-control": "no-store" } });
  }
}
