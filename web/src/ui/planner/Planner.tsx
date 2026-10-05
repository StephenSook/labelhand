"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { evaluate, filterRules, type CompiledLabel } from "@/engine";
import type { AgentCheckSnapshot } from "@/lib/agent/tools";
import { forecastPermittedWindows } from "@/lib/windows";
import {
  PRODUCT_REGISTRATIONS,
  REPLAY_POINTS,
  errorText,
  fetchJson,
  fetchLivePeriods,
  fetchReplay,
  formatForecastTime,
  orderedPointEntries,
  parseForecastPoints,
  parseLabelIndex,
  pointName,
  type FilteredRules,
  type ForecastPeriod,
  type ForecastPoints,
  type LabelIndex,
  type PlannerHour,
  type PlannerRule,
  type ProductRegistration,
  type ReplayForecast,
} from "@/lib/planner-data";
import { WorkingCard, type WorkingStep } from "@/ui";
import { AskTank } from "./AskTank";
import { HourDetail } from "./HourDetail";
import { RulesDisclosure } from "./RulesDisclosure";
import { Timeline } from "./Timeline";

type PlannerProps = {
  initialField?: string;
  initialTank?: string;
  initialReplay?: string;
};

type SourceKind = "LIVE" | "RECORDED";

type PlannerResult = {
  pointKey: string;
  source: SourceKind;
  fetchedAt: string;
  hours: PlannerHour[];
  ruleGroups: FilteredRules[];
};

type Failure = {
  message: string;
  pointKey: string;
  replay?: ReplayForecast;
};

const DEFAULT_FIELD = "tift";

function selectedFromQuery(value: string | undefined): Set<ProductRegistration> {
  if (!value || value === "all") return new Set(PRODUCT_REGISTRATIONS);
  const requested = new Set(value.split(","));
  const selected = PRODUCT_REGISTRATIONS.filter((reg) => requested.has(reg));
  return new Set(selected.length > 0 ? selected : PRODUCT_REGISTRATIONS);
}

function duration(start: number): string {
  return `${Math.max(0, Math.round(performance.now() - start)).toLocaleString("en-US")} ms`;
}

function workingSteps(current: number, measured: Array<string | undefined>): WorkingStep[] {
  const labels = ["Fetch forecast", "Load and filter label rules", "Run the WebAssembly planner"];
  return labels.map((label, index) => ({
    label,
    detail: measured[index] ?? (index === current ? "Running now" : index < current ? "Finished" : "Waiting"),
    status: index < current ? "done" : index === current ? "active" : "waiting",
  }));
}

export function Planner({ initialField, initialTank, initialReplay }: PlannerProps) {
  const replayPoint = initialReplay && REPLAY_POINTS.has(initialReplay) ? initialReplay : undefined;
  const [field, setField] = useState(replayPoint ?? initialField ?? DEFAULT_FIELD);
  const [selectedRegs, setSelectedRegs] = useState<Set<ProductRegistration>>(() => selectedFromQuery(initialTank));
  const [jobHours, setJobHours] = useState(3);
  const [points, setPoints] = useState<ForecastPoints | null>(null);
  const [labels, setLabels] = useState<LabelIndex | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [working, setWorking] = useState<{ startedAt: number; currentStep: number; steps: WorkingStep[] } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<PlannerResult | null>(null);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const autoRan = useRef(false);

  useEffect(() => {
    let current = true;
    Promise.all([
      fetchJson<unknown>("/data/nws_points_cache.json"),
      fetchJson<unknown>("/data/labels/index.json"),
    ])
      .then(([pointsPayload, labelsPayload]) => {
        if (!current) return;
        const loadedPoints = parseForecastPoints(pointsPayload);
        const loadedLabels = parseLabelIndex(labelsPayload);
        setPoints(loadedPoints);
        setLabels(loadedLabels);
        const requested = replayPoint ?? initialField;
        if (requested && loadedPoints[requested]) setField(requested);
      })
      .catch((error) => {
        if (current) setConfigError(errorText(error));
      });
    return () => { current = false; };
  }, [initialField, replayPoint]);

  const runPlanner = useCallback(async ({ pointKey, source, suppliedReplay }: {
    pointKey: string;
    source: SourceKind;
    suppliedReplay?: ReplayForecast;
  }) => {
    if (!points || !labels) return;
    const point = points[pointKey];
    if (!point) {
      setFailure({ message: `No forecast point named ${pointKey} was found in /data/nws_points_cache.json`, pointKey });
      return;
    }
    const registrations = [...selectedRegs];
    if (registrations.length === 0) {
      setValidation("Choose at least one product in the tank.");
      return;
    }

    const startedAt = Date.now();
    const measured: Array<string | undefined> = [];
    setFailure(null);
    setValidation(null);
    setResult(null);
    setSelectedHour(null);
    setWorking({ startedAt, currentStep: 0, steps: workingSteps(0, measured) });

    try {
      const forecastStart = performance.now();
      let periods: ForecastPeriod[];
      let fetchedAt: string;
      if (source === "RECORDED") {
        const replay = suppliedReplay ?? await fetchReplay(pointKey);
        periods = replay.periods;
        fetchedAt = replay.forecast_fetched_utc;
      } else {
        const live = await fetchLivePeriods(point.forecastHourly);
        periods = live.periods;
        fetchedAt = live.fetchedAt;
      }
      measured[0] = duration(forecastStart);
      setWorking({ startedAt, currentStep: 1, steps: workingSteps(1, measured) });

      const rulesStart = performance.now();
      const ruleGroups = await Promise.all(registrations.map(async (reg) => {
        const compiled = await fetchJson<CompiledLabel>(`/data/compiled/${reg}.union.typed.v3.json`);
        return await filterRules(compiled, reg);
      }));
      const usedRules = ruleGroups.flatMap((group) => group.used);
      measured[1] = duration(rulesStart);
      setWorking({ startedAt, currentStep: 2, steps: workingSteps(2, measured) });

      const plannerStart = performance.now();
      const evaluated = await evaluate(usedRules, periods, point.lat, point.lon, 156) as PlannerHour[];
      measured[2] = duration(plannerStart);
      if (evaluated.length !== Math.min(156, periods.length)) {
        throw new Error(`The planner returned ${evaluated.length} hours for ${periods.length} forecast periods`);
      }
      setWorking(null);
      setResult({ pointKey, source, fetchedAt, hours: evaluated, ruleGroups });
    } catch (error) {
      const message = errorText(error);
      setWorking(null);
      if (source === "LIVE" && REPLAY_POINTS.has(pointKey)) {
        try {
          const replay = await fetchReplay(pointKey);
          setFailure({ message, pointKey, replay });
        } catch {
          setFailure({ message, pointKey });
        }
      } else {
        setFailure({ message, pointKey });
      }
    }
  }, [labels, points, selectedRegs]);

  useEffect(() => {
    if (!points || !labels || !replayPoint || autoRan.current) return;
    autoRan.current = true;
    void runPlanner({ pointKey: replayPoint, source: "RECORDED" });
  }, [labels, points, replayPoint, runPlanner]);

  const pointEntries = useMemo(() => points ? orderedPointEntries(points) : [], [points]);
  const selectedProducts = result && labels
    ? result.ruleGroups.map((group) => group.product)
    : [];
  const usedRules = result?.ruleGroups.flatMap((group) => group.used) ?? [];
  const windows = result ? forecastPermittedWindows(result.hours, jobHours) : [];

  function toggleProduct(reg: ProductRegistration) {
    setSelectedRegs((current) => {
      const next = new Set(current);
      if (next.has(reg)) next.delete(reg);
      else next.add(reg);
      setValidation(next.size === 0 ? "Choose at least one product in the tank." : null);
      return next;
    });
  }

  function selectHour(index: number) {
    setSelectedHour(index);
    requestAnimationFrame(() => {
      document.getElementById("hour-detail")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  }

  function scrollToWindow(start: string) {
    const index = result?.hours.findIndex((hour) => hour.start === start) ?? -1;
    if (index < 0) return;
    document.getElementById(`forecast-hour-${index}`)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
      inline: "center",
    });
    selectHour(index);
  }

  function useAgentCheck(snapshot: AgentCheckSnapshot) {
    setField(snapshot.pointKey);
    setJobHours(snapshot.jobHours);
    setSelectedRegs(new Set(snapshot.products.filter((reg): reg is ProductRegistration => PRODUCT_REGISTRATIONS.includes(reg as ProductRegistration))));
    setFailure(null);
    setValidation(null);
    setSelectedHour(null);
    setResult({
      pointKey: snapshot.pointKey,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      hours: snapshot.hours,
      ruleGroups: snapshot.ruleGroups,
    });
  }

  function openAgentClause(ruleId: string) {
    const index = result?.hours.findIndex((hour) =>
      [...hour.blocked, ...hour.checks, ...hour.advisories].some((citation) => citation.rule === ruleId),
    ) ?? -1;
    if (index >= 0) selectHour(index);
  }

  function openAgentWindow(index: number) {
    const selectedWindow = windows[index];
    if (selectedWindow) scrollToWindow(selectedWindow.start);
  }

  return (
    <main className="px-3 pb-6 pt-24 sm:px-5 sm:pt-28">
      <section className="section-card mx-auto max-w-[92rem] overflow-hidden bg-[#9fd3f2] px-4 py-8 text-[#14213d] sm:px-8 sm:py-12 lg:px-12">
        <div className="grid items-start gap-8 lg:grid-cols-[0.82fr_1.18fr]">
          <div className="lg:sticky lg:top-28">
            <p className="hand -rotate-2 text-3xl text-[#14213d]">Georgia cotton · hourly forecast</p>
            <h1 className="display mt-2 text-[clamp(3rem,7vw,6.8rem)] leading-[0.86] tracking-[-0.035em]">Check the tank.</h1>
            <p className="mt-5 max-w-xl text-lg font-bold leading-relaxed">
              Pick a field, the products in the tank, and the job length. The browser checks every selected EPA label against the NWS hourly forecast.
            </p>
            <p className="mt-4 max-w-xl rounded-2xl border-2 border-[#14213d] bg-[#fbf7ee]/85 p-4 text-sm font-semibold">
              FORECAST-PERMITTED means the forecast satisfies every planner-readable rule. FIELD CHECK means the forecast cannot decide. The applicator makes the field decision.
            </p>
          </div>

          <form
            aria-label="Tank planner"
            onSubmit={(event) => {
              event.preventDefault();
              void runPlanner({ pointKey: field, source: "LIVE" });
            }}
            className="rounded-[2rem] border-[3px] border-[#14213d] bg-[#fbf7ee] p-5 shadow-[7px_9px_0_#14213d] sm:p-7"
          >
            <div>
              <label htmlFor="field" className="display text-2xl">1. Field forecast point</label>
              <p className="mt-1 text-sm font-semibold text-[#14213d]/70">Source: National Weather Service hourly forecast grid.</p>
              <select
                id="field"
                value={field}
                onChange={(event) => setField(event.target.value)}
                disabled={!points || Boolean(working)}
                className="mt-3 min-h-12 w-full rounded-2xl border-2 border-[#14213d] bg-white px-4 py-2 font-extrabold outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e]"
              >
                {pointEntries.map(([key, point]) => (
                  <option key={key} value={key}>{pointName(key, point)}</option>
                ))}
              </select>
            </div>

            <fieldset className="mt-7" disabled={!labels || Boolean(working)}>
              <legend className="display text-2xl">2. Products in the tank</legend>
              <p className="mt-1 text-sm font-semibold text-[#14213d]/70">Source: accepted EPA PPLS labels named on each chip.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {PRODUCT_REGISTRATIONS.map((reg) => {
                  const label = labels?.[reg];
                  const checked = selectedRegs.has(reg);
                  return (
                    <label key={reg} className={`flex min-h-20 cursor-pointer items-center gap-3 rounded-2xl border-2 border-[#14213d] px-3 py-3 font-bold outline-offset-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-[#2f8f4e] ${checked ? "bg-[#216a38] text-white" : "bg-white"}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleProduct(reg)} className="size-6 shrink-0 accent-[#ffc53d]" />
                      <span>
                        <span className="block leading-tight">{label?.product ?? reg}</span>
                        <span className="mt-1 block text-xs">EPA Reg. {reg}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-7">
              <label htmlFor="job-hours" className="display text-2xl">3. Job length</label>
              <p className="mt-1 text-sm font-semibold text-[#14213d]/70">How many consecutive forecast-permitted hours the job needs.</p>
              <div className="mt-3 flex items-center gap-4">
                <input
                  id="job-hours"
                  type="range"
                  min={1}
                  max={12}
                  step={1}
                  value={jobHours}
                  onChange={(event) => setJobHours(Number(event.target.value))}
                  disabled={Boolean(working)}
                  className="h-11 min-w-0 flex-1 accent-[#2f8f4e]"
                />
                <output htmlFor="job-hours" className="flex min-h-12 min-w-20 items-center justify-center rounded-2xl border-2 border-[#14213d] bg-[#ffc53d] px-3 text-lg font-black">
                  {jobHours} {jobHours === 1 ? "hour" : "hours"}
                </output>
              </div>
            </div>

            {validation && <p role="alert" className="mt-4 rounded-xl border-2 border-[#d1433f] bg-[#d1433f]/10 p-3 font-bold text-[#9f2926]">{validation}</p>}
            {configError && <p role="alert" className="mt-4 rounded-xl border-2 border-[#d1433f] bg-[#d1433f]/10 p-3 font-bold text-[#9f2926]">Could not load planner data: {configError}</p>}

            <button
              type="submit"
              disabled={!points || !labels || Boolean(working) || selectedRegs.size === 0}
              className="mt-7 inline-flex min-h-14 w-full items-center justify-center rounded-full border-[3px] border-[#14213d] bg-[#ffc53d] px-6 text-lg font-black shadow-[4px_5px_0_#14213d] outline-offset-2 transition-transform hover:-translate-y-0.5 hover:shadow-[5px_7px_0_#14213d] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Check 156 forecast hours
            </button>
          </form>
        </div>

        {working && (
          <div className="mt-8">
            <WorkingCard startedAt={working.startedAt} currentStep={working.currentStep} steps={working.steps} detail="Every duration shown here is measured in this browser." />
          </div>
        )}

        {failure && (
          <section role="alert" className="mt-8 rounded-[1.6rem] border-[3px] border-[#14213d] bg-[#d1433f]/12 p-5">
            <h2 className="display text-3xl">The forecast check did not run</h2>
            <p className="mt-2 break-words font-bold">{failure.message}</p>
            {failure.replay && (
              <button
                type="button"
                onClick={() => void runPlanner({ pointKey: failure.pointKey, source: "RECORDED", suppliedReplay: failure.replay })}
                className="mt-4 min-h-12 rounded-full border-[3px] border-[#14213d] bg-[#ffc53d] px-5 font-black shadow-[3px_4px_0_#14213d] outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d]"
              >
                Use the forecast recorded at {formatForecastTime(failure.replay.forecast_fetched_utc)}
              </button>
            )}
          </section>
        )}
      </section>

      <AskTank onCheck={useAgentCheck} onClause={openAgentClause} onWindow={openAgentWindow} />

      {result && labels && (
        <Results
          result={result}
          labels={labels}
          pointName={pointName(result.pointKey, points?.[result.pointKey] ?? {})}
          jobHours={jobHours}
          windows={windows}
          products={selectedProducts}
          usedRules={usedRules}
          selectedHour={selectedHour}
          onSelectHour={selectHour}
          onSelectWindow={scrollToWindow}
        />
      )}
    </main>
  );
}

type PlannerWindow = ReturnType<typeof forecastPermittedWindows>[number];

function Results({ result, labels, pointName: selectedPointName, jobHours, windows, products, usedRules, selectedHour, onSelectHour, onSelectWindow }: {
  result: PlannerResult;
  labels: LabelIndex;
  pointName: string;
  jobHours: number;
  windows: PlannerWindow[];
  products: string[];
  usedRules: PlannerRule[];
  selectedHour: number | null;
  onSelectHour: (index: number) => void;
  onSelectWindow: (start: string) => void;
}) {
  const counts = result.hours.reduce((acc, hour) => {
    acc[hour.state] += 1;
    return acc;
  }, { PERMITTED: 0, FIELD_CHECK: 0, BLOCKED: 0 });

  return (
    <section aria-labelledby="results-heading" className="section-card mx-auto mt-5 max-w-[92rem] bg-[#fbf7ee] px-4 py-9 text-[#14213d] sm:px-8 lg:px-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="hand -rotate-1 text-3xl text-[#8a5a2b]">{selectedPointName}</p>
          <h2 id="results-heading" className="display text-5xl sm:text-6xl">The forecast window</h2>
        </div>
        <span className={`rounded-full border-[3px] border-[#14213d] px-4 py-2 text-sm font-black ${result.source === "LIVE" ? "bg-[#216a38] text-white" : "bg-[#ffc53d]"}`}>
          {result.source}
        </span>
      </div>

      <p className="mt-4 font-bold">
        {counts.PERMITTED} FORECAST-PERMITTED · {counts.FIELD_CHECK} FIELD CHECK · {counts.BLOCKED} BLOCKED hours
      </p>
      <p className="mt-1 text-sm font-semibold text-[#14213d]/70">
        {result.source === "LIVE" ? "NWS response received" : "NWS forecast recorded"} at {formatForecastTime(result.fetchedAt)}. Source: {result.source === "LIVE" ? "api.weather.gov, fetched by this browser" : "committed NWS replay fixture"}.
      </p>

      <section aria-labelledby="windows-heading" className="mt-8 rounded-[1.7rem] border-[3px] border-[#14213d] bg-[#216a38] p-5 text-white shadow-[5px_6px_0_#14213d] sm:p-7">
        <h3 id="windows-heading" className="display text-3xl">Windows at least {jobHours} {jobHours === 1 ? "hour" : "hours"} long</h3>
        {windows.length === 0 ? (
          <p className="mt-3 font-bold">No run of FORECAST-PERMITTED hours is long enough for this job.</p>
        ) : (
          <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {windows.map((window, index) => (
              <li key={`${window.start}-${index}`}>
                <button
                  type="button"
                  onClick={() => onSelectWindow(window.start)}
                  className="min-h-20 w-full rounded-2xl border-2 border-[#14213d] bg-[#fbf7ee] px-4 py-3 text-left text-[#14213d] outline-offset-2 transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-white"
                >
                  <span className="block text-sm font-black">{formatWindowTime(window.start)} to {formatWindowTime(window.end)}</span>
                  <span className="mt-1 block text-sm font-semibold">{window.length} consecutive {window.length === 1 ? "hour" : "hours"}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Timeline hours={result.hours} products={products} selectedIndex={selectedHour} onSelect={onSelectHour} />
      {selectedHour !== null && result.hours[selectedHour] && (
        <HourDetail hour={result.hours[selectedHour]} labels={labels} usedRules={usedRules} />
      )}
      <RulesDisclosure groups={result.ruleGroups} />
    </section>
  );
}

function formatWindowTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(new Date(value));
}
