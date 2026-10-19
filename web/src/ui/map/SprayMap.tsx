"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { EvaluatedHour } from "@/engine";
import { runPlannerCheck } from "@/lib/run-planner";
import {
  PRODUCT_REGISTRATIONS,
  errorText,
  fetchJson,
  orderedPointEntries,
  parseForecastPoints,
  parseLabelIndex,
  pointName,
  type ForecastPoints,
  type LabelIndex,
  type ProductRegistration,
} from "@/lib/planner-data";
import { fetchMergedSeasonIndex, fetchSeasonDay } from "@/lib/season";
import { isMorningOf, morningIssuance, toReplay } from "@/lib/season-replay";
import {
  dayHour,
  hoursText,
  issuedText,
  mapSummary,
  pointStatus,
  statusHeadline,
  statusOrder,
  windowText,
  type PointStatus,
} from "@/lib/spray-map";

type Mode = "live" | "recorded";

type MapGeometry = {
  bounds: { west: number; east: number; south: number; north: number };
  width: number;
  height: number;
  counties: { fips: string; name: string; point: string | null; label: [number, number]; path: string }[];
};

type PointResult =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; hours: EvaluatedHour[]; nowMs: number; issued: string; morning: boolean };

type Props = {
  initialMode?: string;
  initialDay?: string;
  initialHours?: string;
  initialProducts?: string;
  initialAhead?: string;
};

// Ben Hill sits on top of Irwin, so their labels move apart vertically (frame units).
const LABEL_NUDGE: Record<string, number> = { ben_hill: -14, irwin: 16 };

const MIN_HOURS = 1;
const MAX_HOURS = 12;
// How far past the forecast's own moment the map can be moved, in hours.
const MAX_AHEAD = 72;
const HOUR_MS = 60 * 60 * 1000;

const STATUS_STYLE: Record<PointStatus["kind"] | "loading" | "error", { fill: string; stroke: string; glyph: string; word: string }> = {
  open: { fill: "#2f8f4e", stroke: "#14213d", glyph: "✓", word: "Open now" },
  later: { fill: "#ffc53d", stroke: "#14213d", glyph: "◷", word: "Later" },
  none: { fill: "#f8ddda", stroke: "#b53432", glyph: "✗", word: "No window" },
  loading: { fill: "#e4f4fd", stroke: "#344462", glyph: "…", word: "Checking" },
  error: { fill: "#ffffff", stroke: "#b53432", glyph: "!", word: "No forecast" },
};

function hoursFrom(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_HOURS && parsed <= MAX_HOURS ? parsed : 3;
}

function productsFrom(value: string | undefined): Set<ProductRegistration> {
  const wanted = (value ?? "").split(",").map((item) => item.trim());
  const picked = PRODUCT_REGISTRATIONS.filter((reg) => wanted.includes(reg));
  return new Set(picked.length ? picked : PRODUCT_REGISTRATIONS);
}

function aheadFrom(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_AHEAD ? parsed : 0;
}

function isDay(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function project(geo: MapGeometry, lat: number, lon: number): [number, number] {
  const latMid = ((geo.bounds.south + geo.bounds.north) / 2) * (Math.PI / 180);
  const scale = geo.width / ((geo.bounds.east - geo.bounds.west) * Math.cos(latMid));
  return [(lon - geo.bounds.west) * Math.cos(latMid) * scale, (geo.bounds.north - lat) * scale];
}

const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

export function SprayMap({ initialMode, initialDay, initialHours, initialProducts, initialAhead }: Props) {
  const [points, setPoints] = useState<ForecastPoints | null>(null);
  const [labels, setLabels] = useState<LabelIndex | null>(null);
  const [geo, setGeo] = useState<MapGeometry | null>(null);
  const [days, setDays] = useState<string[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode === "recorded" ? "recorded" : "live");
  const [day, setDay] = useState<string | undefined>(isDay(initialDay) ? initialDay : undefined);
  const [jobHours, setJobHours] = useState(() => hoursFrom(initialHours));
  const [tank, setTank] = useState(() => productsFrom(initialProducts));
  // Results are tagged with the settings they were computed for, so a change of forecast, day
  // or tank shows every field as checking until its own new answer arrives.
  const [run, setRun] = useState<{ key: string; results: Record<string, PointResult>; done: boolean }>({ key: "", results: {}, done: false });
  const [focus, setFocus] = useState<string | null>(null);
  const [ahead, setAhead] = useState(() => aheadFrom(initialAhead));
  const [searching, setSearching] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    Promise.all([
      fetchJson<unknown>("/data/nws_points_cache.json"),
      fetchJson<unknown>("/data/labels/index.json"),
      fetchJson<MapGeometry>("/data/map/south-georgia.json"),
      fetchMergedSeasonIndex(),
    ])
      .then(([pointsPayload, labelsPayload, geometry, season]) => {
        if (!current) return;
        const loadedPoints = parseForecastPoints(pointsPayload);
        // Only days every point recorded, newest first, so the whole map answers for one morning.
        const keys = Object.keys(loadedPoints);
        const common = (season.points[keys[0]]?.days ?? []).filter((candidate) =>
          keys.every((key) => season.points[key]?.days.includes(candidate)),
        );
        setPoints(loadedPoints);
        setLabels(parseLabelIndex(labelsPayload));
        setGeo(geometry);
        setDays([...common].reverse());
      })
      .catch((error) => {
        if (current) setConfigError(errorText(error));
      });
    return () => { current = false; };
  }, []);

  const recordedDay = mode === "recorded" ? (day && days.includes(day) ? day : days[0]) : undefined;
  const tankKey = PRODUCT_REGISTRATIONS.filter((reg) => tank.has(reg)).join(",");
  const runKey = `${mode}|${recordedDay ?? ""}|${tankKey}`;
  const results = useMemo(() => (run.key === runKey ? run.results : {}), [run, runKey]);
  const checkedAt = run.key === runKey && run.done;

  useEffect(() => {
    if (!points || tankKey === "" || (mode === "recorded" && !recordedDay)) return;
    let current = true;
    const registrations = tankKey.split(",");
    const key = `${mode}|${recordedDay ?? ""}|${tankKey}`;
    void Promise.all(Object.keys(points).map(async (pointKey) => {
      let result: PointResult;
      try {
        if (mode === "live") {
          const check = await runPlannerCheck({ pointKey, registrations, points, source: "LIVE" });
          result = { state: "ready", hours: check.hours, nowMs: Date.now(), issued: check.fetchedAt, morning: true };
        } else {
          const file = await fetchSeasonDay(pointKey, recordedDay!);
          const issuance = morningIssuance(file);
          const check = await runPlannerCheck({ pointKey, registrations, points, source: "RECORDED", suppliedReplay: toReplay(issuance) });
          result = {
            state: "ready",
            hours: check.hours,
            nowMs: Date.parse(issuance.fetched_utc),
            issued: issuance.fetched_utc,
            morning: isMorningOf(recordedDay!, issuance.fetched_utc),
          };
        }
      } catch (error) {
        result = { state: "error", message: errorText(error) };
      }
      if (current) {
        setRun((previous) => ({
          key,
          results: { ...(previous.key === key ? previous.results : {}), [pointKey]: result },
          done: false,
        }));
      }
    })).then(() => {
      if (current) setRun((previous) => (previous.key === key ? { ...previous, done: true } : previous));
    });
    return () => { current = false; };
  }, [points, mode, recordedDay, tankKey]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (mode === "recorded") {
      params.set("mode", "recorded");
      if (recordedDay) params.set("day", recordedDay);
    }
    params.set("hours", String(jobHours));
    if (ahead > 0) params.set("ahead", String(ahead));
    if (tankKey && tankKey !== PRODUCT_REGISTRATIONS.join(",")) params.set("products", tankKey);
    window.history.replaceState(null, "", `/map?${params.toString()}`);
  }, [mode, recordedDay, jobHours, tankKey, ahead]);

  const statuses = useMemo(() => {
    const out: Record<string, PointStatus> = {};
    for (const [key, result] of Object.entries(results)) {
      if (result.state === "ready") out[key] = pointStatus(result.hours, jobHours, result.nowMs + ahead * HOUR_MS);
    }
    return out;
  }, [results, jobHours, ahead]);

  const entries = points ? orderedPointEntries(points) : [];
  const ready = entries.length > 0 && entries.every(([key]) => results[key]?.state === "ready" || results[key]?.state === "error");
  const ranked = [...entries].sort(([a], [b]) => {
    const sa = statuses[a];
    const sb = statuses[b];
    if (sa && sb) return statusOrder(sa, sb);
    return sa ? -1 : sb ? 1 : 0;
  });
  const issuedTimes = Object.values(results).flatMap((result) => (result.state === "ready" ? [result.issued] : []));
  const readyTimes = Object.values(results).flatMap((result) => (result.state === "ready" ? [result.nowMs] : []));
  const mapTime = readyTimes.length ? Math.max(...readyTimes) + ahead * HOUR_MS : null;
  const when = ahead === 0 || mapTime === null ? "now" : `at ${dayHour(new Date(mapTime).toISOString())}`;
  const summary = ready ? mapSummary(Object.values(statuses), jobHours, when) : "Checking every field against its forecast.";
  const nothingLive = mode === "live" && ready && Object.values(statuses).length > 0 &&
    Object.values(statuses).every((status) => status.kind === "none");

  // Walks back through the recorded mornings, newest first, until one Tift forecast had a window
  // for this tank and job length, then shows that morning for every field.
  const findSprayableMorning = async () => {
    if (!points) return;
    const registrations = tankKey.split(",");
    for (const candidate of days) {
      setSearching(candidate);
      try {
        const issuance = morningIssuance(await fetchSeasonDay("tift", candidate));
        const check = await runPlannerCheck({ pointKey: "tift", registrations, points, source: "RECORDED", suppliedReplay: toReplay(issuance) });
        if (pointStatus(check.hours, jobHours, Date.parse(issuance.fetched_utc)).kind !== "none") {
          setSearching(null);
          setAhead(0);
          setDay(candidate);
          setMode("recorded");
          return;
        }
      } catch {
        // A morning that cannot be read is skipped; the next one is tried.
      }
    }
    setSearching("none");
  };

  const plannerHref = (pointKey: string) => {
    const params = new URLSearchParams({ field: pointKey, products: tankKey, hours: String(jobHours) });
    const result = results[pointKey];
    if (mode === "recorded" && result?.state === "ready") params.set("issued", result.issued);
    return `/app?${params.toString()}`;
  };

  const kindOf = (pointKey: string): keyof typeof STATUS_STYLE => {
    const result = results[pointKey];
    if (!result || result.state === "loading") return "loading";
    if (result.state === "error") return "error";
    return statuses[pointKey]?.kind ?? "loading";
  };

  const shortStatus = (pointKey: string): string => {
    const status = statuses[pointKey];
    if (!status) return STATUS_STYLE[kindOf(pointKey)].word;
    if (status.kind === "open") return `Open, ${status.hoursLeft} h`;
    if (status.kind === "later") return dayHour(status.window.start);
    return "None";
  };

  const fullStatus = (pointKey: string): string => {
    const result = results[pointKey];
    if (!result || result.state === "loading") return "checking";
    if (result.state === "error") return `no forecast: ${result.message}`;
    return statusHeadline(statuses[pointKey]!, jobHours);
  };

  const clauseLabel = (product: string) =>
    Object.values(labels ?? {}).find((label) => label.product === product)?.shortName ?? product;

  return (
    <main className="px-3 pb-6 pt-24 sm:px-5 sm:pt-28">
      <section className="section-card mx-auto max-w-[92rem] overflow-hidden bg-[#9fd3f2] px-4 py-8 text-[#14213d] sm:px-8 sm:py-12 lg:px-12">
        <div className="grid items-end gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <div>
            <p className="hand -rotate-2 text-3xl">Ten south Georgia fields, one tank</p>
            <h1 className="display mt-2 text-[clamp(2.5rem,5.2vw,5rem)] leading-[0.9] tracking-[-0.035em]">Where can I spray right now?</h1>
          </div>
          <p className="max-w-xl text-base font-bold leading-relaxed">
            Your browser checks the same tank against the NWS hourly forecast at every field, then colors each county by
            when the labels allow the job. Pick a county to open the full planner there.
          </p>
        </div>

        <form
          aria-label="Map settings"
          onSubmit={(event) => event.preventDefault()}
          className="mt-6 grid gap-5 rounded-[2rem] border-[3px] border-[#14213d] bg-[#fbf7ee] p-5 shadow-[7px_9px_0_#14213d] sm:p-6 lg:grid-cols-[auto_1fr_auto]"
        >
          <fieldset>
            <legend className="text-sm font-black">Forecast</legend>
            <div className="mt-2 inline-flex rounded-full border-2 border-[#14213d] bg-white p-1" role="group" aria-label="Forecast source">
              {(["live", "recorded"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  onClick={() => setMode(option)}
                  className={`min-h-11 rounded-full px-4 text-sm font-black ${mode === option ? "bg-[#14213d] text-[#fbf7ee]" : "text-[#14213d]"}`}
                >
                  {option === "live" ? "Live now" : "A recorded morning"}
                </button>
              ))}
            </div>
            {mode === "recorded" && (
              <div className="mt-3">
                <label htmlFor="map-day" className="text-sm font-black">Morning</label>
                <select
                  id="map-day"
                  value={recordedDay ?? ""}
                  onChange={(event) => setDay(event.target.value)}
                  disabled={days.length === 0}
                  className="ml-2 min-h-11 rounded-2xl border-2 border-[#14213d] bg-white px-3 font-extrabold"
                >
                  {days.map((option) => (
                    <option key={option} value={option}>{dayLabel.format(new Date(`${option}T12:00:00Z`))}</option>
                  ))}
                </select>
              </div>
            )}
          </fieldset>

          <fieldset disabled={!labels}>
            <legend className="text-sm font-black">Products in the tank</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRODUCT_REGISTRATIONS.map((reg) => {
                const label = labels?.[reg];
                const checked = tank.has(reg);
                return (
                  <label
                    key={reg}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-[#14213d] px-3 text-sm font-black has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-[#2f8f4e] ${checked ? "bg-[#216a38] text-white" : "bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setTank((current) => {
                        const next = new Set(current);
                        if (next.has(reg)) next.delete(reg);
                        else next.add(reg);
                        return next.size ? next : current;
                      })}
                      aria-label={label ? `${label.shortName}, EPA Reg. ${reg}` : `EPA Reg. ${reg}`}
                      className="size-5 accent-[#ffc53d]"
                    />
                    {label?.shortName ?? reg}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="map-hours" className="text-sm font-black">Job length</label>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="map-hours"
                type="range"
                min={MIN_HOURS}
                max={MAX_HOURS}
                value={jobHours}
                onChange={(event) => setJobHours(Number(event.target.value))}
                className="w-40 accent-[#2f8f4e]"
              />
              <output htmlFor="map-hours" className="min-w-[5.5rem] rounded-full border-2 border-[#14213d] bg-[#ffc53d] px-3 py-1 text-center font-black">
                {hoursText(jobHours)}
              </output>
            </div>
          </div>
        </form>
      </section>

      <section className="section-card mx-auto mt-5 max-w-[92rem] bg-[#fbf7ee] px-4 py-8 text-[#14213d] sm:px-8 lg:px-12" aria-labelledby="map-summary">
        {configError && (
          <p role="alert" className="mb-5 rounded-2xl border-2 border-[#b53432] bg-[#f8ddda] p-4 font-bold">
            The map could not load: {configError}
          </p>
        )}
        <h2 id="map-summary" className="display text-[clamp(1.8rem,3.4vw,3rem)] leading-[0.95]" aria-live="polite">{summary}</h2>
        <p className="mt-3 text-sm font-semibold text-[#14213d]/75" data-map-source>
          {mode === "live"
            ? issuedTimes.length
              ? `Live NWS hourly forecasts fetched by your browser, latest ${issuedText(issuedTimes.sort().at(-1)!)}.`
              : "Fetching live NWS hourly forecasts in your browser."
            : recordedDay
              ? `Recorded NWS forecasts: for each field, the first one issued at or after 7 AM Eastern on ${dayLabel.format(new Date(`${recordedDay}T12:00:00Z`))}, read as of that moment.`
              : "No recorded morning is available yet."}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border-2 border-[#14213d] bg-white px-4 py-3">
          <label htmlFor="map-ahead" className="text-sm font-black">Map time</label>
          <input
            id="map-ahead"
            type="range"
            min={0}
            max={MAX_AHEAD}
            value={ahead}
            onChange={(event) => setAhead(Number(event.target.value))}
            aria-valuetext={mapTime === null ? `${ahead} hours ahead` : `${dayHour(new Date(mapTime).toISOString())}, ${ahead} hours after the forecast`}
            className="min-w-48 flex-1 accent-[#14213d]"
          />
          <output htmlFor="map-ahead" className="min-w-[13rem] text-sm font-black" data-map-time>
            {mapTime === null ? "" : `${dayHour(new Date(mapTime).toISOString())}${ahead === 0 ? (mode === "live" ? ", now" : ", when the forecast was issued") : `, ${hoursText(ahead)} later`}`}
          </output>
        </div>

        {nothingLive && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border-2 border-dashed border-[#14213d] bg-[#fff0b8] px-4 py-3 text-sm font-bold">
            <span>Late-season nights fail the labels&apos; temperature floors, so the live forecast often has no window.</span>
            <button
              type="button"
              onClick={() => void findSprayableMorning()}
              disabled={Boolean(searching && searching !== "none")}
              className="min-h-11 rounded-full border-2 border-[#14213d] bg-[#ffc53d] px-4 font-black shadow-[0_3px_0_#14213d]"
            >
              Show the latest recorded morning with a window
            </button>
            {searching && searching !== "none" && <span role="status">Checking {dayLabel.format(new Date(`${searching}T12:00:00Z`))}</span>}
            {searching === "none" && <span role="status">No recorded morning had a window for this tank and job length.</span>}
          </div>
        )}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <figure className="m-0 rounded-[2rem] border-[3px] border-[#14213d] bg-[#e4f4fd] p-2 shadow-[5px_7px_0_#14213d] lg:sticky lg:top-28">
            {geo && points ? (
              <svg
                viewBox={`0 0 ${geo.width} ${geo.height}`}
                className="block h-auto w-full"
                role="group"
                aria-label={`Map of ten south Georgia counties. ${summary}`}
                data-map
                data-ready={ready ? "true" : "false"}
              >
                {geo.counties.filter((county) => !county.point).map((county) => (
                  <path key={county.fips} d={county.path} fill="#fbf7ee" stroke="#ead4b9" strokeWidth={2} />
                ))}
                {geo.counties.filter((county) => county.point).map((county) => {
                  const key = county.point!;
                  const style = STATUS_STYLE[kindOf(key)];
                  const point = points[key];
                  const [px, py] = point ? project(geo, point.lat, point.lon) : county.label;
                  const [lx, ly] = [county.label[0], county.label[1] + (LABEL_NUDGE[key] ?? 0)];
                  const active = focus === key;
                  return (
                    <a
                      key={county.fips}
                      href={plannerHref(key)}
                      aria-label={`${county.name}: ${fullStatus(key)}. Open the planner for ${county.name}.`}
                      onMouseEnter={() => setFocus(key)}
                      onMouseLeave={() => setFocus(null)}
                      onFocus={() => setFocus(key)}
                      onBlur={() => setFocus(null)}
                      data-county={key}
                      data-status={kindOf(key)}
                    >
                      <path d={county.path} fill={style.fill} fillOpacity={kindOf(key) === "open" ? 0.55 : 0.85} stroke="#14213d" strokeWidth={active ? 6 : 3} />
                      <circle cx={px} cy={py} r={6} fill="#14213d" aria-hidden="true" />
                      <text x={lx} y={ly - 4} textAnchor="middle" fontSize={26} fontWeight={900} fill="#14213d" paintOrder="stroke" stroke="#fbf7ee" strokeWidth={6} aria-hidden="true">{`${style.glyph} ${county.name}`}</text>
                      <text x={lx} y={ly + 22} textAnchor="middle" fontSize={20} fontWeight={800} fill="#14213d" paintOrder="stroke" stroke="#fbf7ee" strokeWidth={5} aria-hidden="true">{shortStatus(key)}</text>
                    </a>
                  );
                })}
              </svg>
            ) : (
              <div className="grid aspect-square place-items-center font-bold">Loading the map</div>
            )}
            <figcaption className="flex flex-wrap gap-x-5 gap-y-2 px-3 pb-2 pt-3 text-sm font-bold">
              {(["open", "later", "none"] as const).map((kind) => (
                <span key={kind} className="inline-flex items-center gap-2">
                  <span aria-hidden="true" className="inline-grid size-6 place-items-center rounded-full border-2 text-xs font-black" style={{ background: STATUS_STYLE[kind].fill, borderColor: STATUS_STYLE[kind].stroke, color: kind === "open" ? "#fff" : "#14213d" }}>
                    {STATUS_STYLE[kind].glyph}
                  </span>
                  {kind === "open" ? `A ${jobHours}-hour job can start ${when}` : kind === "later" ? "Opens later in the forecast" : "No window in the forecast"}
                </span>
              ))}
              <span className="text-[#14213d]/70">County shapes: US Census.</span>
            </figcaption>
          </figure>

          <ol className="m-0 grid list-none content-start gap-2 p-0" aria-label="Fields, soonest window first" data-map-list>
            {ranked.map(([key, point]) => {
              const result = results[key];
              const status = statuses[key];
              const kind = kindOf(key);
              const name = pointName(key, point);
              return (
                <li
                  key={key}
                  data-row={key}
                  className={`rounded-2xl border-2 border-[#14213d] bg-white px-4 py-3 ${focus === key ? "shadow-[4px_5px_0_#14213d]" : ""}`}
                  onMouseEnter={() => setFocus(key)}
                  onMouseLeave={() => setFocus(null)}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="display m-0 text-xl">
                      <Link href={plannerHref(key)} className="underline decoration-2 underline-offset-4 hover:bg-[#ffc53d]">{name}</Link>
                    </h3>
                    <span
                      className="rounded-full border-2 px-3 py-1 text-xs font-black"
                      style={{ background: STATUS_STYLE[kind].fill, borderColor: STATUS_STYLE[kind].stroke, color: kind === "open" ? "#fff" : "#14213d" }}
                    >
                      <span aria-hidden="true">{STATUS_STYLE[kind].glyph} </span>{STATUS_STYLE[kind].word}
                    </span>
                  </div>
                  {result?.state === "error" && <p className="mt-2 text-sm font-semibold">The forecast did not load: {result.message}</p>}
                  {result?.state === "ready" && !result.morning && (
                    <p className="mt-2 text-sm font-semibold">The recorder saved no forecast after 7 AM that day, so this uses the latest one it saved, issued {issuedText(result.issued)}.</p>
                  )}
                  {status?.kind === "open" && (
                    <p className="mt-1 text-sm font-bold">{windowText(status.window)}, {hoursText(status.hoursLeft)} left.</p>
                  )}
                  {status?.kind === "later" && (
                    <p className="mt-1 text-sm font-bold">
                      {windowText(status.window)}, {hoursText(status.window.length)} long, starting in {hoursText(status.startsInHours)}.
                    </p>
                  )}
                  {status?.kind === "none" && (
                    <div className="mt-1 text-sm font-semibold">
                      <p className="m-0">
                        {status.hoursChecked === 0
                          ? "This forecast has no hours left after the map time."
                          : `No ${jobHours}-hour run in the ${hoursText(status.hoursChecked)} ahead.`}
                      </p>
                      {status.topClause && (
                        <p className="m-0 mt-1">
                          Most limiting: {clauseLabel(status.topClause.product)}, page {String(status.topClause.page)},
                          {" "}&quot;{status.topClause.quote.length > 140 ? `${status.topClause.quote.slice(0, 137)}...` : status.topClause.quote}&quot;
                          {" "}({hoursText(status.topClause.hourCount)}).
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        {checkedAt && (
          <p className="mt-5 text-xs font-semibold text-[#14213d]/70">
            Every field was checked in your browser by the same WebAssembly planner the planner page uses. FORECAST-PERMITTED means the forecast
            satisfies every planner-readable rule; the applicator still makes the field decision.
          </p>
        )}
      </section>
    </main>
  );
}
