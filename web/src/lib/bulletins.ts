// EPA's Bulletins Live! Two, the map of Endangered Species Protection Bulletins. This is the app
// that https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins embeds.
export const BULLETINS_LIVE_TWO_URL = "https://blt.epa.gov/blt/public";

// The map's Location Search reads "latitude, longitude" (31.4, -83.6 put the result pin on Tift).
export function bulletinCoordinates(lat: number, lon: number): string {
  const format = (value: number) => String(Number(value.toFixed(4)));
  return `${format(lat)}, ${format(lon)}`;
}

// A Pesticide Use Limitation Area (PULA) that contains the field point.
export type BulletinPula = {
  pula_id: number;
  event_name: string;
  effective_date: string | null;
};

// One limitation EPA lists for a tank registration inside a PULA that contains the field point.
export type BulletinLimitation = {
  pula_id: number;
  code: string;
  text: string;
  reg: string;
};

export type BulletinCheck =
  | {
    status: "checked";
    pulas: BulletinPula[];
    limitations: BulletinLimitation[];
    checkedAt: string;
    source: string;
  }
  | { status: "unavailable"; reason: string };

export const MAX_BULLETIN_REGS = 8;
export const BULLETIN_REG_PATTERN = /^\d{1,6}-\d{1,5}$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

// BLT writes registration numbers without leading zeros ("264-1241", "61842-55").
export function canonicalRegistration(reg: string): string {
  if (!BULLETIN_REG_PATTERN.test(reg)) return reg;
  const [company, product] = reg.split("-").map(Number);
  return `${company}-${product}`;
}

// Window clock times are Eastern, so the application month is the Eastern calendar month.
export function easternMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new RangeError("The Eastern month could not be read from this date.");
  return `${year}-${month}`;
}

// Months counted from year 0, so a range check is integer arithmetic.
export function monthIndex(month: string): number | null {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

// Bulletins Live! Two offers the current month and the next six. A recorded forecast's window can
// sit in a month that has already passed, so the card checks the current month instead.
export function bulletinMonth(windowStart: string | undefined, now: Date = new Date()): string {
  const current = easternMonth(now);
  if (!windowStart) return current;
  const start = new Date(windowStart);
  if (Number.isNaN(start.getTime())) return current;
  const windowMonth = easternMonth(start);
  const windowIndex = monthIndex(windowMonth);
  const currentIndex = monthIndex(current);
  if (windowIndex === null || currentIndex === null) return current;
  if (windowIndex < currentIndex || windowIndex > currentIndex + 6) return current;
  return windowMonth;
}

export function bulletinMonthLabel(month: string): string {
  const index = monthIndex(month);
  if (index === null) return month;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Math.floor(index / 12), index % 12, 15)));
}

export function bulletinCheckPath(lat: number, lon: number, regs: string[], month: string): string {
  const params = new URLSearchParams({
    lat: String(Number(lat.toFixed(6))),
    lon: String(Number(lon.toFixed(6))),
    regs: [...new Set(regs)].join(","),
    month,
  });
  return `/api/bulletins?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(reason: string): BulletinCheck {
  return { status: "unavailable", reason };
}

// The card trusts only a fully formed "checked" answer. Anything else, including a checked answer
// with one malformed row or a limitation for a product that was not asked about, renders as
// unavailable, so a broken response never reads as "no limits".
export function parseBulletinResponse(payload: unknown, requestedRegs?: string[]): BulletinCheck {
  const requested = requestedRegs ? new Set(requestedRegs.map(canonicalRegistration)) : undefined;
  if (!isRecord(payload)) return unavailable("The bulletin check did not return an object.");
  if (payload.status === "unavailable") {
    return unavailable(typeof payload.reason === "string" && payload.reason ? payload.reason : "The bulletin check was unavailable.");
  }
  if (payload.status !== "checked") return unavailable("The bulletin check returned an unknown status.");
  const { pulas, limitations, checkedAt, source } = payload;
  if (!Array.isArray(pulas) || !Array.isArray(limitations)) {
    return unavailable("The bulletin check returned no PULA or limitation list.");
  }
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt)) || typeof source !== "string" || !source) {
    return unavailable("The bulletin check did not say when or where it checked.");
  }
  const parsedPulas: BulletinPula[] = [];
  for (const pula of pulas) {
    if (
      !isRecord(pula)
      || typeof pula.pula_id !== "number" || !Number.isInteger(pula.pula_id)
      || typeof pula.event_name !== "string"
      || (pula.effective_date !== null && typeof pula.effective_date !== "string")
    ) {
      return unavailable("The bulletin check returned a malformed PULA.");
    }
    parsedPulas.push({ pula_id: pula.pula_id, event_name: pula.event_name, effective_date: pula.effective_date });
  }
  const parsedLimitations: BulletinLimitation[] = [];
  for (const limitation of limitations) {
    if (
      !isRecord(limitation)
      || typeof limitation.pula_id !== "number" || !Number.isInteger(limitation.pula_id)
      || typeof limitation.code !== "string" || !limitation.code
      || typeof limitation.text !== "string" || !limitation.text
      || typeof limitation.reg !== "string" || !BULLETIN_REG_PATTERN.test(limitation.reg)
    ) {
      return unavailable("The bulletin check returned a malformed limitation.");
    }
    if (requested && !requested.has(canonicalRegistration(limitation.reg))) {
      return unavailable(`The bulletin check returned a limitation for EPA Reg. No. ${limitation.reg}, which is not in this tank.`);
    }
    parsedLimitations.push({ pula_id: limitation.pula_id, code: limitation.code, text: limitation.text, reg: limitation.reg });
  }
  return { status: "checked", pulas: parsedPulas, limitations: parsedLimitations, checkedAt, source };
}
