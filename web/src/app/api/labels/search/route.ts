import { NextRequest, NextResponse } from "next/server";

import { PplsError, searchProducts } from "@/lib/ppls";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  try {
    const results = await searchProducts(query);
    return NextResponse.json({ results }, {
      headers: { "cache-control": "public, s-maxage=86400, stale-while-revalidate=86400" },
    });
  } catch (error) {
    if (error instanceof PplsError) {
      return NextResponse.json({ error: error.message, status: error.status }, { status: error.status });
    }
    return NextResponse.json({ error: "EPA product search failed.", status: 502 }, { status: 502 });
  }
}
