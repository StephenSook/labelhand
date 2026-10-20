import { NextRequest, NextResponse } from "next/server";

import { BLT_CACHE_SECONDS, BltInputError, checkBulletinsCached, parseBulletinQuery } from "@/lib/blt";

export const runtime = "nodejs";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

// GET /api/bulletins?lat=31.4&lon=-83.6&regs=228-653,228-659&month=2026-11
export async function GET(request: NextRequest) {
  // LABELHAND_BLT_LIVE=off keeps a server from calling EPA (the end-to-end test server sets it).
  if (process.env.LABELHAND_BLT_LIVE === "off") {
    return NextResponse.json(
      { status: "unavailable", reason: "Live Bulletins Live! Two lookups are switched off on this server." },
      { headers: NO_STORE },
    );
  }

  let query;
  try {
    query = parseBulletinQuery(request.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof BltInputError) {
      return NextResponse.json({ status: "unavailable", reason: error.message }, { status: 400, headers: NO_STORE });
    }
    throw error;
  }

  const result = await checkBulletinsCached(query);
  if (result.status !== "checked") return NextResponse.json(result, { status: 502, headers: NO_STORE });
  return NextResponse.json(result, {
    headers: { "cache-control": `public, max-age=0, s-maxage=${BLT_CACHE_SECONDS}` },
  });
}
