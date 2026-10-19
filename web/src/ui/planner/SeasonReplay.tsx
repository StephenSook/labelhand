"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Rule } from "@/engine";
import { errorText, type ReplayForecast } from "@/lib/planner-data";
import {
  fetchSeasonDay,
  isSeasonNotRecorded,
  type SeasonDay,
  type SeasonIssuance,
} from "@/lib/season";
import {
  bestScored,
  fetchSeasonIndex,
  morningIssuance,
  scoreIssuance,
  toReplay,
  type ScoredIssuance,
} from "@/lib/season-replay";

export type SeasonScores = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  days: SeasonDay[];
  scored: ScoredIssuance[];
  best?: ScoredIssuance;
  totalIssuances: number;
  span?: { first: string; last: string };
};

const EMPTY: SeasonScores = { status: "idle", days: [], scored: [], totalIssuances: 0 };

// Scores one recorded morning per day for the current point, tank and job length.
export function useSeasonScores(
  pointKey: string | undefined,
  rules: Rule[] | undefined,
  lat: number | undefined,
  lon: number | undefined,
  jobHours: number,
): SeasonScores {
  const ruleKey = rules?.map((rule) => rule.id).join("|") ?? "";
  const valid = Boolean(pointKey && rules && rules.length > 0 && lat !== undefined && lon !== undefined);
  const key = valid ? `${pointKey}|${ruleKey}|${lat}|${lon}|${jobHours}` : "";
  // Scores are stored with the inputs they were computed for; a stale entry reads as loading.
  const [stored, setStored] = useState<{ key: string; scores: SeasonScores }>({ key: "", scores: EMPTY });

  useEffect(() => {
    if (!valid || !pointKey || !rules || lat === undefined || lon === undefined) return;
    let current = true;
    (async () => {
      const index = await fetchSeasonIndex();
      const point = index.points[pointKey];
      if (!point) throw new Error(`No recorded season for ${pointKey}.`);
      const loaded = await Promise.all(point.days.map(async (day) => {
        try {
          return await fetchSeasonDay(pointKey, day);
        } catch (error) {
          if (isSeasonNotRecorded(error)) return undefined;
          throw error;
        }
      }));
      const days = loaded.filter((day): day is SeasonDay => day !== undefined);
      const scored: ScoredIssuance[] = [];
      for (const day of days) {
        scored.push(await scoreIssuance(day.day, morningIssuance(day), rules, lat, lon, jobHours));
      }
      if (!current) return;
      setStored({
        key,
        scores: {
          status: "ready",
          days,
          scored,
          best: bestScored(scored),
          totalIssuances: days.reduce((sum, day) => sum + day.issuances.length, 0),
          span: index.recorded_span,
        },
      });
    })().catch((error) => {
      if (current) setStored({ key, scores: { ...EMPTY, status: "error", error: errorText(error) } });
    });
    return () => { current = false; };
    // key covers every input; the rules array itself is rebuilt on every planner run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!valid) return EMPTY;
  return stored.key === key ? stored.scores : { ...EMPTY, status: "loading" };
}

export function issuanceFor(scores: SeasonScores, fetchedUtc: string): SeasonIssuance | undefined {
  for (const day of scores.days) {
    const found = day.issuances.find((issuance) => issuance.fetched_utc === fetchedUtc);
    if (found) return found;
  }
  return undefined;
}

const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const longDayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const clockFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
// Issuance times are Eastern and a UTC day file starts at 8 PM Eastern the evening before, so each
// option carries its own Eastern date (review 2026-10-19: "Oct 6 at 8:07 PM" was really Oct 5).
const issuedFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function dayLabel(day: string, formatter = dayFormatter): string {
  return formatter.format(new Date(`${day}T12:00:00Z`));
}

export function SeasonReplay({ pointName, jobHours, scores, activeFetchedUtc, busy, onReplay }: {
  pointName: string;
  jobHours: number;
  scores: SeasonScores;
  activeFetchedUtc?: string;
  busy: boolean;
  onReplay: (replay: ReplayForecast) => void;
}) {
  const [selectedDay, setSelectedDay] = useState<string | undefined>(undefined);
  const [selectedIssued, setSelectedIssued] = useState<string | undefined>(undefined);

  const activeDay = useMemo(() => scores.days.find((day) =>
    day.issuances.some((issuance) => issuance.fetched_utc === activeFetchedUtc))?.day, [activeFetchedUtc, scores.days]);
  const shownDay = selectedDay ?? activeDay ?? scores.best?.day;
  const dayRecord = scores.days.find((day) => day.day === shownDay);
  const dayScore = scores.scored.find((score) => score.day === shownDay);
  const issued = selectedIssued && dayRecord?.issuances.some((issuance) => issuance.fetched_utc === selectedIssued)
    ? selectedIssued
    : dayScore?.fetchedUtc;
  const maxHours = Math.max(1, ...scores.scored.map((score) => score.permittedHours));
  // Review 2026-10-19: Tift has no forecasts from 08:07Z Oct 16 to 01:07Z Oct 17, so "every hour" was false.
  // Expected counts the whole hours between the first and last recording, inclusive.
  const coverage = scores.status === "ready" && scores.span
    ? {
        recorded: scores.days.reduce((sum, day) => sum + day.issuances.length, 0),
        expected: Math.floor((Date.parse(scores.span.last) - Date.parse(scores.span.first)) / 3_600_000) + 1,
      }
    : undefined;
  const stripRef = useRef<HTMLOListElement>(null);

  // On a phone the strip scrolls sideways; keep the shown day in view without moving the page.
  useEffect(() => {
    const strip = stripRef.current;
    const pressed = strip?.querySelector<HTMLElement>("button[aria-pressed=true]");
    if (!strip || !pressed) return;
    const item = pressed.parentElement ?? pressed;
    strip.scrollLeft = Math.max(0, item.offsetLeft - strip.offsetLeft - (strip.clientWidth - item.clientWidth) / 2);
  }, [shownDay, scores.status]);

  function replay(fetchedUtc: string | undefined) {
    const issuance = fetchedUtc ? issuanceFor(scores, fetchedUtc) : undefined;
    if (issuance) onReplay(toReplay(issuance));
  }

  return (
    <section
      id="season-replay"
      aria-labelledby="season-replay-heading"
      className="mt-8 scroll-mt-28 rounded-[1.7rem] border-[3px] border-[#14213d] bg-white p-5 shadow-[5px_6px_0_#14213d] sm:p-7"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <p className="hand -rotate-1 text-3xl text-[#2f6f9f]">recorded hourly since Oct 5</p>
          <h2 id="season-replay-heading" className="display mt-1 text-4xl sm:text-5xl">Replay the season</h2>
          <p className="mt-3 text-lg font-semibold leading-relaxed">
            The National Weather Service only serves today&apos;s forecast. Labelhand saved it hourly for ten Georgia cotton
            points, so the planner can run on the forecast an applicator read on most mornings of the 2026 defoliation season.
          </p>
          {coverage ? (
            <p data-season-coverage className="mt-2 text-sm font-semibold text-[#14213d]/75">
              {coverage.recorded.toLocaleString("en-US")} of {coverage.expected.toLocaleString("en-US")} hourly forecasts were recorded for {pointName};
              the recorder missed hours when its computer was off.
            </p>
          ) : null}
        </div>
        {scores.best ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setSelectedDay(scores.best!.day);
              setSelectedIssued(undefined);
              replay(scores.best!.fetchedUtc);
            }}
            className="min-h-12 rounded-full border-[3px] border-[#14213d] bg-[#ffc53d] px-5 font-black shadow-[3px_4px_0_#14213d] outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Replay the best morning ({dayLabel(scores.best.day)})
          </button>
        ) : null}
      </div>

      {scores.status === "loading" && <p className="mt-5 font-bold" role="status">Running the planner on every recorded morning for {pointName}.</p>}
      {scores.status === "error" && <p className="mt-5 rounded-xl border-2 border-[#d1433f] bg-[#d1433f]/10 p-3 font-bold text-[#9f2926]" role="alert">The recorded season could not load: {scores.error}</p>}

      {scores.status === "ready" && (
        <>
          <ol ref={stripRef} aria-label={`Recorded mornings at ${pointName}, forecast-permitted hours for this tank`} className="relative mt-6 flex gap-2 overflow-x-auto pb-3">
            {scores.scored.map((score) => {
              const selected = score.day === shownDay;
              const fits = score.windows.length;
              const tone = fits > 0 ? "bg-[#216a38]" : score.permittedHours > 0 ? "bg-[#ffc53d]" : "bg-[#14213d]/15";
              const issuedNote = score.morning
                ? ""
                : `. The recorder saved no forecast after 7 AM that day; this bar uses the one issued ${issuedFormatter.format(new Date(score.fetchedUtc))} Eastern`;
              const summary = `${dayLabel(score.day, longDayFormatter)}: ${score.permittedHours} forecast-permitted hours, ${fits === 0 ? "no window fits" : `${fits} ${fits === 1 ? "window fits" : "windows fit"}`} a ${jobHours}-hour job${issuedNote}`;
              return (
                <li key={score.day} className="shrink-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={summary}
                    title={summary}
                    onClick={() => {
                      setSelectedDay(score.day);
                      setSelectedIssued(undefined);
                    }}
                    className={`flex w-[4.6rem] flex-col items-center rounded-2xl border-2 px-1.5 pb-2 pt-2 text-center outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e] ${selected ? "border-[#14213d] bg-[#fbf7ee] shadow-[3px_4px_0_#14213d]" : "border-[#14213d]/30 bg-white"}`}
                  >
                    <span className="text-xs font-extrabold">{dayLabel(score.day).split(", ")[0]}</span>
                    <span className="text-sm font-black">{dayLabel(score.day).split(", ")[1]}</span>
                    <span aria-hidden="true" className="mt-2 flex h-20 w-6 items-end rounded-md border-2 border-[#14213d] bg-white">
                      <span className={`block w-full rounded-[3px] ${tone}`} style={{ height: `${Math.max(score.permittedHours > 0 ? 8 : 0, Math.round((score.permittedHours / maxHours) * 100))}%` }} />
                    </span>
                    <span className="mt-1 text-sm font-black">{score.permittedHours} h</span>
                    <span className="text-[0.7rem] font-bold leading-tight">{fits === 0 ? "no window" : `${fits} ${fits === 1 ? "window" : "windows"}`}</span>
                    {score.morning ? null : (
                      <span data-not-morning className="mt-1 rounded-md border border-[#14213d] px-1 text-[0.65rem] font-black leading-tight">
                        {clockFormatter.format(new Date(score.fetchedUtc))} only
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          {dayRecord && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="font-bold">
                <span className="block text-sm">Forecasts recorded on {dayLabel(dayRecord.day, longDayFormatter)} (UTC day), issued at</span>
                <select
                  value={issued}
                  onChange={(event) => setSelectedIssued(event.target.value)}
                  className="mt-1 min-h-12 rounded-2xl border-2 border-[#14213d] bg-white px-3 font-extrabold outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e]"
                >
                  {[...dayRecord.issuances]
                    .sort((a, b) => Date.parse(a.fetched_utc) - Date.parse(b.fetched_utc))
                    .map((issuance) => (
                      <option key={issuance.fetched_utc} value={issuance.fetched_utc}>
                        {issuedFormatter.format(new Date(issuance.fetched_utc))} Eastern
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !issued}
                onClick={() => replay(issued)}
                className="min-h-12 rounded-full border-[3px] border-[#14213d] bg-[#216a38] px-5 font-black text-white shadow-[3px_4px_0_#14213d] outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#ffc53d] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run the planner on this forecast
              </button>
            </div>
          )}

          <p className="mt-4 text-sm font-semibold text-[#14213d]/75">
            Bars count forecast-permitted hours in the first forecast issued after 7 AM Eastern each day, for this tank and a {jobHours}-hour job.
            {" "}On a day the recorder missed the morning, the bar uses the latest forecast it saved and shows that time.
            {" "}{scores.totalIssuances.toLocaleString("en-US")} hourly NWS forecasts recorded for {pointName}
            {scores.span ? ` from ${dayLabel(scores.span.first.slice(0, 10))} to ${dayLabel(scores.span.last.slice(0, 10))}` : ""} by the
            project&apos;s recorder (<code>tools/nws_recorder.py</code>).
          </p>
        </>
      )}
    </section>
  );
}
