const EASTERN_TIME_ZONE = "America/New_York";

function parts(value: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function easternDay(value: Date): string {
  const local = parts(value);
  return `${local.year}-${local.month}-${local.day}`;
}

export function isEasternQuietHour(value: Date): boolean {
  const hour = Number(parts(value).hour);
  return hour >= 21 || hour < 6;
}

const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

const weekday = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  weekday: "long",
});

export function spokenWindow(startIso: string, endIso: string, now: Date): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = easternDay(start);
  const today = easternDay(now);
  const tomorrow = easternDay(new Date(now.getTime() + 24 * 60 * 60 * 1_000));
  const when = day === today ? "today" : day === tomorrow ? "tomorrow" : `on ${weekday.format(start)}`;
  return `from ${clock.format(start)} to ${clock.format(end)} ${when}, Eastern`;
}
