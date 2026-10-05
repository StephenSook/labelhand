"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCheckSnapshot } from "@/lib/agent/tools";
import { runPlannerCheck, type PlannerCheckResult, type PlannerSource } from "@/lib/run-planner";
import { forecastPermittedWindows } from "@/lib/windows";
import { isRestrictedUseLabel } from "@/lib/label-restrictions";
import type { SprayRecordClause, SprayRecordInput } from "@/lib/spray-record";
import {
  PRODUCT_REGISTRATIONS,
  REPLAY_POINTS,
  errorText,
  fetchJson,
  fetchReplay,
  formatForecastTime,
  orderedPointEntries,
  parseForecastPoints,
  parseLabelIndex,
  pointName,
  type ForecastPoints,
  type LabelIndex,
  type PlannerRule,
  type ProductRegistration,
  type ReplayForecast,
} from "@/lib/planner-data";
import { WorkingCard, type WorkingStep } from "@/ui";
import { AskTank } from "./AskTank";
import { HourDetail } from "./HourDetail";
import { RulesDisclosure } from "./RulesDisclosure";
import { SprayRecordButton } from "./SprayRecordButton";
import { Timeline } from "./Timeline";
import { WhyFewWindows } from "./WhyFewWindows";

type PlannerProps = {
  initialField?: string;
  initialProducts?: string;
  initialHours?: string;
  initialReplay?: string;
};

type Failure = {
  message: string;
  pointKey: string;
  replay?: ReplayForecast;
};

const DEFAULT_FIELD = "tift";

function selectedFromQuery(value: string | undefined): Set<ProductRegistration> {
  if (!value || value === "all") return new Set(PRODUCT_REGISTRATIONS);
  const requested = value.split(",");
  if (
    requested.length === 0
    || new Set(requested).size !== requested.length
    || requested.some((reg) => !PRODUCT_REGISTRATIONS.includes(reg as ProductRegistration))
  ) {
    return new Set(PRODUCT_REGISTRATIONS);
  }
  return new Set(PRODUCT_REGISTRATIONS.filter((reg) => requested.includes(reg)));
}

function hoursFromQuery(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : 3;
}

function duration(milliseconds: number): string {
  return `${Math.max(0, Math.round(milliseconds)).toLocaleString("en-US")} ms`;
}

function workingSteps(current: number, measured: Array<string | undefined>): WorkingStep[] {
  const labels = ["Fetch forecast", "Load and filter label rules", "Run the WebAssembly planner"];
  return labels.map((label, index) => ({
    label,
    detail: measured[index] ?? (index === current ? "Running now" : index < current ? "Finished" : "Waiting"),
    status: index < current ? "done" : index === current ? "active" : "waiting",
  }));
}

export function Planner({ initialField, initialProducts, initialHours, initialReplay }: PlannerProps) {
  const replayPoint = initialReplay && REPLAY_POINTS.has(initialReplay) ? initialReplay : undefined;
  const [field, setField] = useState(replayPoint ?? initialField ?? DEFAULT_FIELD);
  const [selectedRegs, setSelectedRegs] = useState<Set<ProductRegistration>>(() => selectedFromQuery(initialProducts));
  const [jobHours, setJobHours] = useState(() => hoursFromQuery(initialHours));
  const [activeReplay, setActiveReplay] = useState(replayPoint);
  const [points, setPoints] = useState<ForecastPoints | null>(null);
  const [labels, setLabels] = useState<LabelIndex | null>(null);
  const [configReady, setConfigReady] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [working, setWorking] = useState<{ startedAt: number; currentStep: number; steps: WorkingStep[] } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<PlannerCheckResult | null>(null);
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
        const requested = replayPoint ?? initialField;
        setField(requested && loadedPoints[requested] ? requested : DEFAULT_FIELD);
        setPoints(loadedPoints);
        setLabels(loadedLabels);
        setConfigReady(true);
      })
      .catch((error) => {
        if (current) setConfigError(errorText(error));
      });
    return () => { current = false; };
  }, [initialField, replayPoint]);

  const runPlanner = useCallback(async ({ pointKey, source, suppliedReplay, fallbackToReplay = false }: {
    pointKey: string;
    source: PlannerSource;
    suppliedReplay?: ReplayForecast;
    fallbackToReplay?: boolean;
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
      const checked = await runPlannerCheck({
        pointKey,
        registrations,
        points,
        source,
        suppliedReplay,
        fallbackToReplay,
        onProgress: (completedStep, durationMs) => {
          measured[completedStep - 1] = duration(durationMs);
          if (completedStep < 3) {
            setWorking({ startedAt, currentStep: completedStep, steps: workingSteps(completedStep, measured) });
          }
        },
      });
      setActiveReplay(checked.source === "RECORDED" ? pointKey : undefined);
      setWorking(null);
      setResult(checked);
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
    if (!points || !labels || !configReady || autoRan.current) return;
    autoRan.current = true;
    void runPlanner({
      pointKey: field,
      source: replayPoint ? "RECORDED" : "LIVE",
      fallbackToReplay: !replayPoint,
    });
  }, [configReady, field, labels, points, replayPoint, runPlanner]);

  useEffect(() => {
    if (!configReady) return;
    const params = new URLSearchParams(window.location.search);
    params.set("field", field);
    params.set(
      "products",
      PRODUCT_REGISTRATIONS.filter((reg) => selectedRegs.has(reg)).join(","),
    );
    params.set("hours", String(jobHours));
    params.delete("tank");
    if (activeReplay) params.set("replay", activeReplay);
    else params.delete("replay");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  }, [activeReplay, configReady, field, jobHours, selectedRegs]);

  const pointEntries = useMemo(() => points ? orderedPointEntries(points) : [], [points]);
  const selectedProducts = result && labels
    ? result.ruleGroups.map((group) => {
        const label = Object.values(labels).find((candidate) => candidate.product === group.product);
        return {
          fullName: group.product,
          shortName: label?.shortName ?? group.product,
          reg: label?.reg,
        };
      })
    : [];
  const usedRules = result?.ruleGroups.flatMap((group) => group.used) ?? [];
  const windows = result ? forecastPermittedWindows(result.hours, jobHours) : [];

  function toggleProduct(reg: ProductRegistration) {
    setSelectedRegs((current) => {
      const next = new Set(current);
      if (next.has(reg)) next.delete(reg);
      else next.add(reg);
      setActiveReplay(undefined);
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
    const registrations = snapshot.products.filter(
      (reg): reg is ProductRegistration => PRODUCT_REGISTRATIONS.includes(reg as ProductRegistration),
    );
    setField(snapshot.pointKey);
    setJobHours(snapshot.jobHours);
    setActiveReplay(snapshot.source === "RECORDED" ? snapshot.pointKey : undefined);
    setSelectedRegs(new Set(registrations));
    setFailure(null);
    setValidation(null);
    setSelectedHour(null);
    setResult({
      pointKey: snapshot.pointKey,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      periods: snapshot.periods,
      lat: snapshot.lat,
      lon: snapshot.lon,
      hours: snapshot.hours,
      ruleGroups: snapshot.ruleGroups,
      registrations,
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
              setActiveReplay(undefined);
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
                onChange={(event) => {
                  setField(event.target.value);
                  setActiveReplay(undefined);
                }}
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
                    <label
                      key={reg}
                      title={label ? `${label.product}, EPA Reg. ${reg}` : undefined}
                      className={`flex min-h-20 cursor-pointer items-center gap-3 rounded-2xl border-2 border-[#14213d] px-3 py-3 font-bold outline-offset-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-[#2f8f4e] ${checked ? "bg-[#216a38] text-white" : "bg-white"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProduct(reg)}
                        aria-label={label ? `${label.shortName}, ${label.product}, EPA Reg. ${reg}` : `EPA Reg. ${reg}`}
                        className="size-6 shrink-0 accent-[#ffc53d]"
                      />
                      <span>
                        <span className="block leading-tight">{label?.shortName ?? reg}</span>
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
                  onChange={(event) => {
                    setJobHours(Number(event.target.value));
                    setActiveReplay(undefined);
                  }}
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

      <AskTank onCheck={useAgentCheck} onClause={openAgentClause} onWindow={openAgentWindow} />
    </main>
  );
}

type PlannerWindow = ReturnType<typeof forecastPermittedWindows>[number];

function shownRecordValue(value: unknown, suffix = ""): string {
  return value === null || value === undefined || value === "" ? "Not supplied" : `${String(value)}${suffix}`;
}

function sprayRecordForWindow(
  result: PlannerCheckResult,
  labels: LabelIndex,
  fieldName: string,
  window: PlannerWindow,
): SprayRecordInput {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const hours = result.hours.filter((hour) => {
    const time = Date.parse(hour.start);
    return time >= startMs && time < endMs;
  });
  const first = hours[0];
  if (!first) throw new Error(`No forecast hour was found at ${window.start}.`);

  const clauses = new Map<string, SprayRecordClause>();
  for (const hour of hours) {
    for (const [kind, citations] of [
      ["FIELD CHECK", hour.checks] as const,
      ["ADVISORY", hour.advisories] as const,
    ]) {
      for (const citation of citations) {
        const clause: SprayRecordClause = {
          kind,
          product: citation.product,
          page: String(citation.page),
          quote: citation.quote,
        };
        clauses.set(JSON.stringify(clause), clause);
      }
    }
  }

  return {
    fieldName,
    lat: result.lat,
    lon: result.lon,
    windowStart: window.start,
    windowEnd: window.end,
    source: result.source,
    forecastFetchedAt: result.fetchedAt,
    weather: {
      temperature: shownRecordValue(first.temp_f, "°F"),
      wind: shownRecordValue(first.wind),
      rainChance: shownRecordValue(first.pop, "%"),
      sunAltitude: `${first.sun_alt.toFixed(1)}°`,
    },
    products: result.registrations.map((reg) => {
      const label = labels[reg];
      if (!label) throw new Error(`No accepted label metadata was found for EPA Reg. ${reg}.`);
      return {
        product: label.product,
        reg: label.reg,
        accepted: label.accepted,
        restrictedUse: isRestrictedUseLabel(label),
      };
    }),
    clauses: [...clauses.values()],
  };
}

function Results({ result, labels, pointName: selectedPointName, jobHours, windows, products, usedRules, selectedHour, onSelectHour, onSelectWindow }: {
  result: PlannerCheckResult;
  labels: LabelIndex;
  pointName: string;
  jobHours: number;
  windows: PlannerWindow[];
  products: Array<{ fullName: string; shortName: string; reg?: string }>;
  usedRules: PlannerRule[];
  selectedHour: number | null;
  onSelectHour: (index: number) => void;
  onSelectWindow: (start: string) => void;
}) {
  const counts = result.hours.reduce((acc, hour) => {
    acc[hour.state] += 1;
    return acc;
  }, { PERMITTED: 0, FIELD_CHECK: 0, BLOCKED: 0 });
  const allPermittedWindows = forecastPermittedWindows(result.hours, 1);
  const selectedHourValue = selectedHour === null ? undefined : result.hours[selectedHour];
  const selectedWindow = selectedHourValue?.state === "PERMITTED"
    ? allPermittedWindows.find((window) => {
        const selected = Date.parse(selectedHourValue.start);
        return selected >= Date.parse(window.start) && selected < Date.parse(window.end);
      })
    : undefined;
  const selectedSprayRecord = selectedWindow
    ? sprayRecordForWindow(result, labels, selectedPointName, selectedWindow)
    : undefined;
  const nextWindow = windows[0];
  const tankLabel = products.map((product) => product.shortName).join(", ");
  const tankDescription = products
    .map((product) => product.reg ? `${product.fullName}, EPA Reg. ${product.reg}` : product.fullName)
    .join("; ");

  return (
    <section
      id="planner-results"
      data-forecast-source={result.source}
      aria-labelledby="next-window-heading"
      className="section-card mx-auto mt-5 max-w-[92rem] bg-[#fbf7ee] px-4 py-9 text-[#14213d] sm:px-8 lg:px-12"
    >
      <section
        id="next-window"
        aria-labelledby="next-window-heading"
        className={`scroll-mt-28 rounded-[1.7rem] border-[3px] border-[#14213d] p-5 shadow-[5px_6px_0_#14213d] sm:p-7 ${nextWindow ? "bg-[#216a38] text-white" : "bg-[#ffc53d]"}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`hand -rotate-1 text-3xl ${nextWindow ? "text-[#ffc53d]" : "text-[#8a5a2b]"}`}>{selectedPointName}</p>
            <h2 id="next-window-heading" className="display mt-1 text-5xl sm:text-6xl">Next window</h2>
          </div>
          <span className={`rounded-full border-[3px] px-4 py-2 text-sm font-black ${nextWindow ? "border-white bg-white text-[#155b2c]" : "border-[#14213d] bg-[#fbf7ee]"}`}>
            {result.source}
          </span>
        </div>

        <p className={`mt-4 text-sm font-semibold ${nextWindow ? "text-white/85" : "text-[#14213d]/75"}`}>
          {result.source === "LIVE" ? "NWS response received" : "NWS forecast recorded"} at {formatForecastTime(result.fetchedAt)}
        </p>
        <p className="mt-3 font-bold" title={tankDescription} aria-label={`Tank products: ${tankDescription}`}>
          Tank: {tankLabel}
        </p>

        {nextWindow ? (
          <div className="mt-5 grid items-end gap-5 lg:grid-cols-[1fr_auto]">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.12em]">{formatWindowDay(nextWindow.start)}</p>
              <p className="display mt-1 text-4xl sm:text-5xl">
                {formatWindowClock(nextWindow.start)} to {formatWindowClock(nextWindow.end)}
              </p>
              <p className="mt-2 text-lg font-bold">{nextWindow.length} consecutive {nextWindow.length === 1 ? "hour" : "hours"}</p>
              <button
                type="button"
                onClick={() => onSelectWindow(nextWindow.start)}
                className="mt-3 min-h-11 rounded-full border-2 border-white px-4 py-2 text-sm font-black underline decoration-2 underline-offset-4 outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#ffc53d]"
              >
                Show this window in the timeline
              </button>
            </div>
            <SprayRecordButton
              id="spray-record"
              input={sprayRecordForWindow(result, labels, selectedPointName, nextWindow)}
            />
          </div>
        ) : (
          <p className="mt-5 text-lg font-black">
            No forecast-permitted window fits this {jobHours}-hour job in the forecast.{" "}
            <a href="#why-few-windows" className="underline decoration-4 underline-offset-4">Why so few windows?</a>
          </p>
        )}

        <p className={`mt-5 border-t-2 pt-4 text-sm font-bold ${nextWindow ? "border-white/45" : "border-[#14213d]/35"}`}>
          {counts.PERMITTED} FORECAST-PERMITTED · {counts.FIELD_CHECK} FIELD CHECK · {counts.BLOCKED} BLOCKED hours
        </p>
        {result.liveFailure ? (
          <p className={`mt-3 rounded-xl border-2 p-3 text-sm font-bold ${nextWindow ? "border-white bg-white/10" : "border-[#8a5a2b] bg-[#fbf7ee]/55"}`}>
            The live NWS request failed, so this first check uses the recorded forecast: {result.liveFailure}
          </p>
        ) : null}
      </section>

      <Timeline hours={result.hours} products={products} selectedIndex={selectedHour} onSelect={onSelectHour} />
      {selectedHour !== null && result.hours[selectedHour] && (
        <HourDetail hour={result.hours[selectedHour]} labels={labels} usedRules={usedRules} sprayRecord={selectedSprayRecord} />
      )}
      <WhyFewWindows
        key={`${result.pointKey}-${result.fetchedAt}-${result.ruleGroups.map((group) => group.product).join("|")}-${jobHours}`}
        hours={result.hours}
        ruleGroups={result.ruleGroups}
        periods={result.periods}
        lat={result.lat}
        lon={result.lon}
        jobHours={jobHours}
        labels={labels}
      />
      <RulesDisclosure groups={result.ruleGroups} labels={labels} />
    </section>
  );
}

function formatWindowDay(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function formatWindowClock(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
