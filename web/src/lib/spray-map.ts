import type { EvaluatedHour } from "@/engine";
import { forecastPermittedWindows, rankLimitingClauses, type ClauseImpact, type ForecastWindow } from "@/lib/windows";

const ONE_HOUR_MS = 60 * 60 * 1000;

// What one forecast point can do for a job of jobHours, read at `nowMs` (the present for a live
// forecast, the moment a recorded forecast was issued for a season replay).
export type PointStatus =
  | { kind: "open"; window: ForecastWindow; hoursLeft: number }
  | { kind: "later"; window: ForecastWindow; startsInHours: number }
  | { kind: "none"; hoursChecked: number; topClause: ClauseImpact | null };

export function pointStatus(hours: EvaluatedHour[], jobHours: number, nowMs: number): PointStatus {
  const windows = forecastPermittedWindows(hours, jobHours);
  for (const window of windows) {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    if (end <= nowMs) continue;
    if (start <= nowMs) {
      // The current hour is inside a permitted run. It counts as open only if a full job still
      // fits before the run ends; otherwise the job has to wait for a later window.
      const hoursLeft = Math.floor((end - nowMs) / ONE_HOUR_MS);
      if (hoursLeft >= jobHours) return { kind: "open", window, hoursLeft };
      continue;
    }
    return { kind: "later", window, startsInHours: Math.ceil((start - nowMs) / ONE_HOUR_MS) };
  }
  const ahead = hours.filter((hour) => Date.parse(hour.start) + ONE_HOUR_MS > nowMs);
  return { kind: "none", hoursChecked: ahead.length, topClause: rankLimitingClauses(ahead)[0] ?? null };
}

// Open fields first, then the soonest later window, then fields with none, each by name.
export function statusOrder(a: PointStatus, b: PointStatus): number {
  const rank = (status: PointStatus) => (status.kind === "open" ? 0 : status.kind === "later" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.kind === "later" && b.kind === "later") return Date.parse(a.window.start) - Date.parse(b.window.start);
  return 0;
}

const easternDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
const easternHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" });
const easternDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const easternClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

// "Tue 2 PM"
export function dayHour(iso: string): string {
  const date = new Date(iso);
  return `${easternDay.format(date)} ${easternHour.format(date).replace(/ /g, " ")}`;
}

// "Tue 2 PM to 7 PM", or across midnight "Tue 10 PM to Wed 2 AM"
export function windowText(window: ForecastWindow): string {
  const start = new Date(window.start);
  const end = new Date(window.end);
  const sameDay = easternDay.format(start) === easternDay.format(end);
  const endText = sameDay ? easternHour.format(end) : dayHour(window.end);
  return `${dayHour(window.start)} to ${endText.replace(/ /g, " ")}`;
}

export function issuedText(iso: string): string {
  const date = new Date(iso);
  return `${easternDate.format(date)}, ${easternClock.format(date).replace(/ /g, " ")} Eastern`;
}

export function hoursText(count: number): string {
  return `${count} ${count === 1 ? "hour" : "hours"}`;
}

export function statusHeadline(status: PointStatus, jobHours: number): string {
  if (status.kind === "open") return `Open for ${hoursText(status.hoursLeft)}`;
  if (status.kind === "later") return `Next: ${windowText(status.window)}`;
  return `No ${jobHours}-hour window`;
}

export function mapSummary(statuses: PointStatus[], jobHours: number, when = "now"): string {
  const open = statuses.filter((status) => status.kind === "open").length;
  const later = statuses.filter((status) => status.kind === "later").length;
  const total = statuses.length;
  const job = `${jobHours}-hour job`;
  if (open > 0 && open === total) return `All ${total} fields can start a ${job} ${when}.`;
  if (open > 0 && later === 0) {
    return `${open} of ${total} fields can start a ${job} ${when}. The rest have no ${job} in the forecast.`;
  }
  if (open > 0) {
    return `${open} of ${total} fields can start a ${job} ${when}. ${later} more open later in the forecast.`;
  }
  if (later > 0) return `No field can start a ${job} ${when}. ${later} of ${total} open later in the forecast.`;
  return `No field has a ${job} anywhere in the forecast.`;
}
