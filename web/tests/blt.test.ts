import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GET } from "@/app/api/bulletins/route";
import {
  BLT_UPSTREAM_TIMEOUT_MS,
  BltInputError,
  BltUpstreamError,
  CONTROL_POINT,
  CONTROL_REG,
  candidatePulasUrl,
  checkBulletins,
  checkBulletinsCached,
  clearBulletinCache,
  firstOfNextMonth,
  limitationsUrl,
  parseBulletinQuery,
  parseLimitations,
  parsePointPulas,
  plainLimitationText,
  pointQueryUrl,
  type BulletinQuery,
} from "@/lib/blt";

// Every fixture is a real Bulletins Live! Two response; sources.json records the URL, HTTP status
// and time of each fetch (scripts/capture-blt-fixtures.ts, 2026-10-20).
const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "blt");
type Source = { url: string; http_status: number; fetched_utc: string; note: string };
const sources = JSON.parse(readFileSync(path.join(FIXTURES, "sources.json"), "utf8")) as Record<string, Source>;

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
}

const NOW = new Date("2026-10-20T21:00:00Z");
const MONTH = "2026-11";
const TANK = ["264-418", "264-700", "5481-504"];
const TIFT = { lat: 31.4, lon: -83.6 };
const DOOLY_PULA_121 = { lat: 32.21361, lon: -83.73173 };

type Reply = { status: number; body: unknown } | { text: string } | Error;

// Serves the recorded fixture for each URL it was captured from; any other URL fails the test.
function fakeFetch(overrides: Record<string, Reply> = {}) {
  const byUrl = new Map<string, Reply>();
  for (const [file, source] of Object.entries(sources)) byUrl.set(source.url, { status: source.http_status, body: fixture(file) });
  for (const [url, reply] of Object.entries(overrides)) byUrl.set(url, reply);
  const calls: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    signals.push(init?.signal);
    const reply = byUrl.get(url);
    if (!reply) throw new Error(`No recorded Bulletins Live! Two response for ${url}`);
    if (reply instanceof Error) throw reply;
    if ("text" in reply) return new Response(reply.text, { status: 200, headers: { "content-type": "application/json" } });
    return Response.json(reply.body, { status: reply.status });
  }) as typeof fetch;
  return { impl, calls, signals };
}

function query(point: { lat: number; lon: number }, regs: string[]): BulletinQuery {
  return { lat: point.lat, lon: point.lon, regs: [...regs].sort(), month: MONTH };
}

beforeEach(() => {
  clearBulletinCache();
});

describe("recorded requests", () => {
  test("each fixture was fetched with the URL the route builds", () => {
    expect(sources["point-tift.json"].url).toBe(pointQueryUrl(TIFT.lat, TIFT.lon));
    expect(sources["point-ware-control.json"].url).toBe(pointQueryUrl(CONTROL_POINT.lat, CONTROL_POINT.lon));
    expect(sources["point-dooly-pula-121.json"].url).toBe(pointQueryUrl(DOOLY_PULA_121.lat, DOOLY_PULA_121.lon));
    expect(sources["candidates-labelhand-tank-2026-11.json"].url).toBe(candidatePulasUrl(TANK, MONTH));
    expect(sources["candidates-stryax-2026-11.json"].url).toBe(candidatePulasUrl([CONTROL_REG], MONTH));
    expect(sources["limitations-stryax-pula-121.json"].url).toBe(limitationsUrl([121], [CONTROL_REG]));
    for (const source of Object.values(sources)) expect(source.fetched_utc.startsWith("2026-10-20T")).toBe(true);
  });

  test("the product filter is the one the BLT web app sends, null entry included", () => {
    const where = JSON.parse(new URL(candidatePulasUrl(TANK, MONTH)).searchParams.get("where") ?? "null");
    expect(where).toEqual({
      limitations: { product_registration_number: { in: [null, "264-418", "264-700", "5481-504"] } },
      effective_date: { "<": "12/1/2026" },
    });
  });

  test("the month filter rolls the year", () => {
    expect(firstOfNextMonth("2026-11")).toBe("12/1/2026");
    expect(firstOfNextMonth("2026-12")).toBe("1/1/2027");
  });
});

describe("input validation", () => {
  const valid = { lat: "31.4", lon: "-83.6", regs: "264-700,264-418", month: MONTH };
  const params = (values: Record<string, string>) => new URLSearchParams(values);

  test("reads a valid request and normalizes registration numbers to BLT's form", () => {
    expect(parseBulletinQuery(params({ ...valid, regs: "000264-00700,264-418,264-700" }), NOW)).toEqual({
      lat: 31.4,
      lon: -83.6,
      regs: ["264-418", "264-700"],
      month: MONTH,
    });
  });

  test.each([
    ["latitude out of range", { lat: "91" }],
    ["longitude out of range", { lon: "-181" }],
    ["latitude written as an exponent", { lat: "3e1" }],
    ["latitude not a number", { lat: "north" }],
    ["empty longitude", { lon: "" }],
    ["state SLN number", { regs: "GA-120005" }],
    ["registration with a space", { regs: "264-700, 264-418" }],
    ["empty registration list", { regs: "" }],
    ["nine registrations", { regs: "1-1,1-2,1-3,1-4,1-5,1-6,1-7,1-8,1-9" }],
    ["month without a zero", { month: "2026-1" }],
    ["month 13", { month: "2026-13" }],
    ["a month that has passed", { month: "2026-09" }],
    ["seven months ahead", { month: "2027-05" }],
  ])("rejects %s", (_name, change) => {
    expect(() => parseBulletinQuery(params({ ...valid, ...change }), NOW)).toThrow(BltInputError);
  });

  test("rejects a missing or repeated parameter", () => {
    expect(() => parseBulletinQuery(params({ lon: "-83.6", regs: "264-700", month: MONTH }), NOW)).toThrow(BltInputError);
    const repeated = params(valid);
    repeated.append("lat", "32");
    expect(() => parseBulletinQuery(repeated, NOW)).toThrow(BltInputError);
  });

  test("accepts this month through six months ahead", () => {
    expect(parseBulletinQuery(params({ ...valid, month: "2026-10" }), NOW).month).toBe("2026-10");
    expect(parseBulletinQuery(params({ ...valid, month: "2027-04" }), NOW).month).toBe("2027-04");
  });
});

describe("parsing the PULA map", () => {
  test("a field outside every PULA has none", () => {
    expect(parsePointPulas(fixture("point-tift.json"))).toEqual([]);
  });

  test("the Ware County control point sits in four PULAs", () => {
    const pulas = parsePointPulas(fixture("point-ware-control.json"));
    expect(pulas.map((pula) => pula.pula_id)).toEqual([91, 96, 97, 110]);
    expect(pulas.find((pula) => pula.pula_id === 110)).toMatchObject({
      event_name: "NMFS Methomyl 2025",
      effective_date: "2025-08-11T00:00:00.000Z",
    });
  });

  test("an error object sent with HTTP 200 is an error", () => {
    expect(() => parsePointPulas(fixture("point-error-unknown-field.json"))).toThrow(BltUpstreamError);
  });

  test("a truncated feature list is an error, not a set of PULAs", () => {
    expect(() => parsePointPulas(fixture("point-truncated-bad-geometry.json"))).toThrow(/truncated/);
  });

  test("a response without a feature list is an error", () => {
    expect(() => parsePointPulas({ displayFieldName: "event_name" })).toThrow(BltUpstreamError);
    expect(() => parsePointPulas([])).toThrow(BltUpstreamError);
  });
});

describe("parsing limitations", () => {
  test("STRYAX in PULA 121 gives one DC125 limitation as plain text", () => {
    const limitations = parseLimitations(fixture("limitations-stryax-pula-121.json"), new Set([121]), new Set([CONTROL_REG]));
    expect(limitations).toHaveLength(1);
    expect(limitations[0]).toMatchObject({ pula_id: 121, code: "DC125", reg: CONTROL_REG });
    expect(limitations[0].text).toBe(
      "This crop use is located within a PULA. Therefore, 3 ADDITIONAL points (for a total of 6 points) of runoff/erosion mitigations must be achieved for this crop use using the Mitigation Menu (https://www.epa.gov/pesticides/mitigation-menu).",
    );
  });

  test("rows that ignore the filter that was sent make the answer untrusted", () => {
    expect(() => parseLimitations(fixture("limitations-ignored-filter.json"), new Set([121]), new Set([CONTROL_REG])))
      .toThrow(/not asked for/);
  });

  test("a limitation that names no product is not attributed to a tank product", () => {
    // The real STRYAX row with its product number removed in this test.
    const [row] = fixture("limitations-stryax-pula-121.json") as Array<Record<string, unknown>>;
    expect(() => parseLimitations([{ ...row, product_registration_number: null }], new Set([121]), new Set([CONTROL_REG])))
      .toThrow(/names no product/);
  });

  test("HTML entities in EPA text are decoded", () => {
    const [open, close] = [String.fromCodePoint(0x201c), String.fromCodePoint(0x201d)];
    expect(plainLimitationText("Use &lt;10 mph&gt; winds &amp; <b>no</b>&nbsp;drift &#8220;here&#x201D;."))
      .toBe(`Use <10 mph> winds & no drift ${open}here${close}.`);
  });
});

describe("the bulletin check", () => {
  test("our tank at the tift field: no PULA and no limitation, after both controls pass", async () => {
    const upstream = fakeFetch();
    const result = await checkBulletins(query(TIFT, TANK), upstream.impl, NOW);
    expect(result).toEqual({
      status: "checked",
      pulas: [],
      limitations: [],
      checkedAt: NOW.toISOString(),
      source: expect.stringContaining("not a Bulletin"),
    });
    expect(upstream.calls).toContain(pointQueryUrl(CONTROL_POINT.lat, CONTROL_POINT.lon));
    expect(upstream.calls).toContain(candidatePulasUrl([CONTROL_REG], MONTH));
  });

  test("our tank at the Ware control point: four PULAs, none limits these products", async () => {
    const result = await checkBulletins(query(CONTROL_POINT, TANK), fakeFetch().impl, NOW);
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    expect(result.pulas.map((pula) => pula.pula_id)).toEqual([91, 96, 97, 110]);
    expect(result.limitations).toEqual([]);
  });

  test("STRYAX at a point in PULA 121 lists its limitation", async () => {
    const result = await checkBulletins(query(DOOLY_PULA_121, [CONTROL_REG]), fakeFetch().impl, NOW);
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    expect(result.pulas).toEqual([{ pula_id: 121, event_name: "Dicamba 2026", effective_date: "2026-02-09T00:00:00.000Z" }]);
    expect(result.limitations).toEqual([expect.objectContaining({ pula_id: 121, code: "DC125", reg: CONTROL_REG })]);
  });

  test("every upstream call carries an abort signal for the 8 second limit", async () => {
    const upstream = fakeFetch();
    await checkBulletins(query(TIFT, TANK), upstream.impl, NOW);
    expect(BLT_UPSTREAM_TIMEOUT_MS).toBe(8_000);
    expect(upstream.signals.length).toBeGreaterThan(0);
    for (const signal of upstream.signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  const tiftPoint = pointQueryUrl(TIFT.lat, TIFT.lon);
  const tankCandidates = candidatePulasUrl(TANK, MONTH);
  test.each<[string, Record<string, Reply>]>([
    ["the PULA map cannot be reached", { [tiftPoint]: new TypeError("fetch failed") }],
    ["the PULA map times out", { [tiftPoint]: new DOMException("The operation was aborted due to timeout", "TimeoutError") }],
    ["the PULA map answers with an error object", { [tiftPoint]: { status: 200, body: fixture("point-error-unknown-field.json") } }],
    ["the PULA map returns a truncated list", { [tiftPoint]: { status: 200, body: fixture("point-truncated-bad-geometry.json") } }],
    ["pulas_public answers HTTP 400", { [tankCandidates]: { status: 400, body: fixture("limitations-invalid-where-400.json") } }],
    ["pulas_public answers HTTP 500", { [tankCandidates]: { status: 500, body: [{ message: "invalid input syntax for type timestamp" }] } }],
    ["pulas_public returns something that is not JSON", { [tankCandidates]: { text: "<html>Service Unavailable</html>" } }],
    ["the control point comes back empty", { [pointQueryUrl(CONTROL_POINT.lat, CONTROL_POINT.lon)]: { status: 200, body: fixture("point-tift.json") } }],
    ["the control product comes back empty", { [candidatePulasUrl([CONTROL_REG], MONTH)]: { status: 200, body: [] } }],
    ["the control point cannot be reached", { [pointQueryUrl(CONTROL_POINT.lat, CONTROL_POINT.lon)]: new TypeError("fetch failed") }],
  ])("an empty answer is never returned when %s", async (_name, overrides) => {
    const result = await checkBulletins(query(TIFT, TANK), fakeFetch(overrides).impl, NOW);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reason.length).toBeGreaterThan(0);
  });

  test("a matched PULA with no limitation text is unavailable, not checked", async () => {
    const result = await checkBulletins(query(DOOLY_PULA_121, [CONTROL_REG]), fakeFetch({
      [limitationsUrl([121], [CONTROL_REG])]: { status: 200, body: [] },
    }).impl, NOW);
    expect(result).toEqual({ status: "unavailable", reason: expect.stringContaining("PULA 121") });
  });

  test("limitation rows for other products make the answer unavailable", async () => {
    const result = await checkBulletins(query(DOOLY_PULA_121, [CONTROL_REG]), fakeFetch({
      [limitationsUrl([121], [CONTROL_REG])]: { status: 200, body: fixture("limitations-ignored-filter.json") },
    }).impl, NOW);
    expect(result.status).toBe("unavailable");
  });

  test("a PULA for these products that is not effective yet cannot be placed, so the answer is unavailable", async () => {
    // The real STRYAX candidates with PULA 122 moved to a future effective date in this test.
    const candidates = (fixture("candidates-stryax-2026-11.json") as Array<Record<string, unknown>>)
      .map((row) => row.pula_id === 122 ? { ...row, effective_date: "2026-11-15T05:00:00.000Z" } : row);
    const result = await checkBulletins(query(DOOLY_PULA_121, [CONTROL_REG]), fakeFetch({
      [candidatePulasUrl([CONTROL_REG], MONTH)]: { status: 200, body: candidates },
    }).impl, NOW);
    expect(result).toEqual({ status: "unavailable", reason: expect.stringContaining("PULA 122") });
  });
});

describe("caching", () => {
  test("a checked answer is reused without asking EPA again", async () => {
    const upstream = fakeFetch();
    const first = await checkBulletinsCached(query(TIFT, TANK), upstream.impl, NOW);
    const callsAfterFirst = upstream.calls.length;
    const second = await checkBulletinsCached(query(TIFT, TANK), upstream.impl, new Date(NOW.getTime() + 60_000));
    expect(second).toEqual(first);
    expect(upstream.calls.length).toBe(callsAfterFirst);
  });

  test("a checked answer expires after three hours", async () => {
    const upstream = fakeFetch();
    await checkBulletinsCached(query(TIFT, TANK), upstream.impl, NOW);
    const callsAfterFirst = upstream.calls.length;
    await checkBulletinsCached(query(TIFT, TANK), upstream.impl, new Date(NOW.getTime() + 3 * 60 * 60 * 1000 + 1));
    expect(upstream.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test("an unavailable answer is not cached", async () => {
    const failing = fakeFetch({ [pointQueryUrl(TIFT.lat, TIFT.lon)]: new TypeError("fetch failed") });
    expect((await checkBulletinsCached(query(TIFT, TANK), failing.impl, NOW)).status).toBe("unavailable");
    expect((await checkBulletinsCached(query(TIFT, TANK), fakeFetch().impl, NOW)).status).toBe("checked");
  });
});

describe("GET /api/bulletins", () => {
  const url = "http://localhost/api/bulletins?lat=31.4&lon=-83.6&regs=5481-504,264-700,264-418&month=2026-11";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("answers a checked result with a shared cache lifetime", async () => {
    vi.stubGlobal("fetch", fakeFetch().impl);
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=10800");
    expect(await response.json()).toMatchObject({ status: "checked", pulas: [], limitations: [] });
  });

  test("answers an upstream failure as unavailable and uncached", async () => {
    vi.stubGlobal("fetch", fakeFetch({ [pointQueryUrl(TIFT.lat, TIFT.lon)]: new TypeError("fetch failed") }).impl);
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "unavailable" });
  });

  test("rejects invalid input with 400 before calling EPA", async () => {
    const upstream = fakeFetch();
    vi.stubGlobal("fetch", upstream.impl);
    const response = await GET(new NextRequest("http://localhost/api/bulletins?lat=95&lon=-83.6&regs=264-700&month=2026-11"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "unavailable" });
    expect(upstream.calls).toEqual([]);
  });

  test("LABELHAND_BLT_LIVE=off answers unavailable without calling EPA", async () => {
    vi.stubEnv("LABELHAND_BLT_LIVE", "off");
    const upstream = fakeFetch();
    vi.stubGlobal("fetch", upstream.impl);
    const response = await GET(new NextRequest(url));
    expect(await response.json()).toMatchObject({ status: "unavailable" });
    expect(upstream.calls).toEqual([]);
  });
});
