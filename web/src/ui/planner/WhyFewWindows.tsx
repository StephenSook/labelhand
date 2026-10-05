"use client";

import { useState } from "react";
import { evaluate } from "@/engine";
import type {
  FilteredRules,
  ForecastPeriod,
  PlannerHour,
  PlannerRule,
} from "@/lib/planner-data";
import {
  forecastPermittedWindows,
  isTankCompositionRule,
  rankLimitingClauses,
  rankLimitingProducts,
} from "@/lib/windows";

type Scenario = {
  id: string;
  label: string;
  detail: string;
  rules: PlannerRule[];
};

type Outcome =
  | { state: "running" }
  | { state: "error"; message: string }
  | { state: "ready"; permittedHours: number; windows: ReturnType<typeof forecastPermittedWindows> };

type WhyFewWindowsProps = {
  hours: PlannerHour[];
  ruleGroups: FilteredRules[];
  periods: ForecastPeriod[];
  lat: number;
  lon: number;
  jobHours: number;
};

function blockedByRule(hours: PlannerHour[], rule: PlannerRule, product: string): boolean {
  return hours.some((hour) => hour.blocked.some((citation) =>
    citation.product === product && citation.rule === rule.id && citation.quote === rule.quote,
  ));
}

function whatIfScenarios(hours: PlannerHour[], ruleGroups: FilteredRules[]): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const group of ruleGroups) {
    for (const [index, rule] of group.used.entries()) {
      if (!isTankCompositionRule(rule) || !blockedByRule(hours, rule, group.product)) continue;
      scenarios.push({
        id: `alone-${group.product}-${rule.id}-${index}`,
        label: `Check ${group.product} alone`,
        detail: `Page ${String(rule.page)} says to use it alone when the clause's temperature condition holds.`,
        rules: group.used,
      });
    }
  }

  if (ruleGroups.length > 1) {
    const products = rankLimitingProducts(hours);
    const highest = products[0]?.hourCount;
    for (const impact of products.filter((item) => item.hourCount === highest)) {
      const remaining = ruleGroups.filter((group) => group.product !== impact.product);
      if (remaining.length === 0) continue;
      scenarios.push({
        id: `without-${impact.product}`,
        label: `Check without ${impact.product}`,
        detail: `${impact.product} keeps ${impact.hourCount} forecast hours from the permitted state in this run.`,
        rules: remaining.flatMap((group) => group.used),
      });
    }
  }
  return scenarios;
}

function windowLabel(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
  return `${formatter.format(new Date(start))} to ${formatter.format(new Date(end))}`;
}

export function WhyFewWindows({ hours, ruleGroups, periods, lat, lon, jobHours }: WhyFewWindowsProps) {
  const clauses = rankLimitingClauses(hours).slice(0, 3);
  const scenarios = whatIfScenarios(hours, ruleGroups);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  async function runScenario(scenario: Scenario) {
    setOutcomes((current) => ({ ...current, [scenario.id]: { state: "running" } }));
    try {
      const evaluated = await evaluate(scenario.rules, periods, lat, lon, 156) as PlannerHour[];
      setOutcomes((current) => ({
        ...current,
        [scenario.id]: {
          state: "ready",
          permittedHours: evaluated.filter((hour) => hour.state === "PERMITTED").length,
          windows: forecastPermittedWindows(evaluated, jobHours),
        },
      }));
    } catch (error) {
      setOutcomes((current) => ({
        ...current,
        [scenario.id]: {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }

  return (
    <section
      aria-labelledby="few-windows-heading"
      className="mt-8 rounded-[1.7rem] border-[3px] border-[#14213d] bg-[#9fd3f2] p-5 shadow-[5px_6px_0_#14213d] sm:p-7"
    >
      <p className="hand -rotate-1 text-3xl text-[#14213d]">the constraint ledger</p>
      <h3 id="few-windows-heading" className="display mt-1 text-4xl">Why so few windows?</h3>
      <p className="mt-3 max-w-3xl font-bold">
        These clauses affect the most forecast hours. Each clause is counted once per hour, whether it blocks the hour or sends it to a field check.
      </p>

      <ol aria-label="Top limiting clauses" className="mt-5 grid gap-4 lg:grid-cols-3">
        {clauses.map((clause) => (
          <li key={`${clause.product}-${clause.rule}-${clause.quote}`} className="rounded-2xl border-2 border-[#14213d] bg-[#fbf7ee] p-4">
            <p className="text-xs font-black uppercase tracking-[0.12em]">{clause.hourCount} {clause.hourCount === 1 ? "hour" : "hours"}</p>
            <p className="mt-2 font-black">{clause.product} · Page {String(clause.page)}</p>
            <blockquote className="mt-3 border-l-4 border-[#8a5a2b] pl-3 text-sm font-semibold leading-relaxed">
              &quot;{clause.quote}&quot;
            </blockquote>
            <p className="mt-3 text-xs font-bold text-[#14213d]/70">
              {clause.blockedHours} blocked · {clause.fieldCheckHours} field check
            </p>
          </li>
        ))}
      </ol>

      {scenarios.length > 0 && (
        <div className="mt-7 border-t-2 border-[#14213d] pt-6">
          <h4 className="display text-3xl">Run a real what-if</h4>
          <p className="mt-2 max-w-3xl font-semibold">
            Each button reruns the same WebAssembly planner on this forecast with a different tank. It does not fetch new data.
          </p>
          <ul className="mt-4 grid gap-4 md:grid-cols-2">
            {scenarios.map((scenario) => {
              const outcome = outcomes[scenario.id];
              return (
                <li key={scenario.id} className="rounded-2xl border-2 border-[#14213d] bg-white p-4">
                  <button
                    type="button"
                    disabled={outcome?.state === "running"}
                    onClick={() => void runScenario(scenario)}
                    className="min-h-12 rounded-full border-[3px] border-[#14213d] bg-[#ffc53d] px-5 font-black shadow-[3px_4px_0_#14213d] outline-offset-2 transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#216a38] disabled:cursor-wait disabled:opacity-60"
                  >
                    {outcome?.state === "running" ? "Checking..." : scenario.label}
                  </button>
                  <p className="mt-3 text-sm font-semibold text-[#14213d]/75">{scenario.detail}</p>
                  {outcome?.state === "error" && <p role="alert" className="mt-3 font-bold text-[#9f2926]">Could not run this what-if: {outcome.message}</p>}
                  {outcome?.state === "ready" && (
                    <div role="status" aria-live="polite" data-what-if-result className="mt-4 rounded-xl border-2 border-[#216a38] bg-[#d9efdf] p-3">
                      <p className="font-black">
                        {outcome.permittedHours} of {hours.length} forecast-permitted hours · {outcome.windows.length} {outcome.windows.length === 1 ? "window" : "windows"} at least {jobHours} {jobHours === 1 ? "hour" : "hours"} long
                      </p>
                      {outcome.windows.length > 0 ? (
                        <ul className="mt-2 list-disc pl-5 text-sm font-semibold">
                          {outcome.windows.map((window) => (
                            <li key={window.start}>{windowLabel(window.start, window.end)} · {window.length} hours</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm font-semibold">No qualifying window in this forecast.</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
