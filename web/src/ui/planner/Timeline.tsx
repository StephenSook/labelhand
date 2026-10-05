"use client";

import { useMemo, useRef } from "react";
import {
  displayState,
  stateIcon,
  type PlannerHour,
} from "@/lib/planner-data";

type TimelineProps = {
  hours: PlannerHour[];
  products: Array<{ fullName: string; shortName: string; reg?: string }>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
};

type HourEntry = { hour: PlannerHour; index: number };

type DayGroup = {
  key: string;
  label: string;
  hours: HourEntry[];
};

type DayRun = {
  entries: HourEntry[];
  bindingProducts: string[];
};

const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "long",
  month: "short",
  day: "numeric",
});

const hourLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
});

const compactHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hour12: true,
});

const runHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hour12: true,
});

const hourColumn = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

function groupByDay(hours: PlannerHour[]): DayGroup[] {
  const groups: DayGroup[] = [];
  hours.forEach((hour, index) => {
    const date = new Date(hour.start);
    const key = dayKey.format(date);
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      groups.push({ key, label: dayLabel.format(date), hours: [{ hour, index }] });
    } else {
      current.hours.push({ hour, index });
    }
  });
  return groups;
}

function stateClass(state: PlannerHour["state"]): string {
  if (state === "BLOCKED") return "border-[#9f2926] bg-[#d1433f] text-white";
  if (state === "FIELD_CHECK") return "border-[#8a5a2b] bg-[#ffc53d] text-[#14213d]";
  return "border-[#155b2c] bg-[#216a38] text-white";
}

function summaryStateClass(state: PlannerHour["state"]): string {
  if (state === "BLOCKED") return "bg-[#d1433f] text-white";
  if (state === "FIELD_CHECK") return "bg-[#ffc53d] text-[#14213d]";
  return "bg-[#216a38] text-white";
}

function abbreviation(state: PlannerHour["state"]): string {
  if (state === "BLOCKED") return "BLOCK";
  if (state === "FIELD_CHECK") return "CHECK";
  return "OK";
}

function bindingCitations(hour: PlannerHour): PlannerHour["blocked"] {
  if (hour.state === "BLOCKED") return hour.blocked;
  if (hour.state === "FIELD_CHECK") return hour.checks;
  return [];
}

function bindingProducts(hour: PlannerHour): string[] {
  return [...new Set(bindingCitations(hour).map((citation) => citation.product))].sort();
}

function accessibleHourName(hour: PlannerHour): string {
  const time = hourLabel.format(new Date(hour.start));
  const clauses = bindingCitations(hour)
    .map((citation) => `${citation.product}: ${citation.quote}`)
    .join("; ");
  return clauses
    ? `${time}, ${displayState(hour.state)}. ${clauses}`
    : `${time}, ${displayState(hour.state)}`;
}

function compactHourLabel(value: string): string {
  const parts = compactHour.formatToParts(new Date(value));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const period = parts.find((part) => part.type === "dayPeriod")?.value.at(0)?.toLowerCase() ?? "";
  return `${hour}${period}`;
}

function localHour(value: string): number {
  return Number(hourColumn.format(new Date(value)));
}

function productState(hour: PlannerHour, product: string): "blocked" | "check" | "clear" {
  if (hour.blocked.some((citation) => citation.product === product)) return "blocked";
  if (hour.checks.some((citation) => citation.product === product)) return "check";
  return "clear";
}

function groupRuns(entries: HourEntry[]): DayRun[] {
  const runs: DayRun[] = [];
  for (const entry of entries) {
    const products = bindingProducts(entry.hour);
    const current = runs.at(-1);
    if (
      !current
      || current.entries[0].hour.state !== entry.hour.state
      || current.bindingProducts.length !== products.length
      || current.bindingProducts.some((product, index) => product !== products[index])
    ) {
      runs.push({ entries: [entry], bindingProducts: products });
    } else {
      current.entries.push(entry);
    }
  }
  return runs;
}

function runLabel(run: DayRun): string {
  const first = run.entries[0].hour;
  const last = run.entries.at(-1)?.hour ?? first;
  const end = new Date(new Date(last.start).getTime() + 60 * 60 * 1000);
  const length = run.entries.length;
  return `${runHour.format(new Date(first.start))} to ${runHour.format(end)} · ${displayState(first.state)} · ${length} h`;
}

export function Timeline({ hours, products, selectedIndex, onSelect }: TimelineProps) {
  const groups = useMemo(() => groupByDay(hours), [hours]);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const today = dayKey.format(new Date());
  const hasToday = groups.some((group) => group.key === today);
  const productNames = useMemo(
    () => new Map(products.map((product) => [product.fullName, product.shortName])),
    [products],
  );

  function moveFocus(index: number, delta: number) {
    const next = Math.max(0, Math.min(hours.length - 1, index + delta));
    refs.current[next]?.focus();
    onSelect(next);
  }

  return (
    <section id="timeline" aria-labelledby="timeline-heading" className="mt-10 scroll-mt-28">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="hand -rotate-1 text-2xl text-[#8a5a2b]">strictest label sets the hour</p>
          <h2 id="timeline-heading" className="display text-4xl sm:text-5xl">Hour-by-hour check</h2>
        </div>
        <ul aria-label="Timeline key" className="flex flex-wrap gap-2 text-xs font-extrabold">
          <li className="rounded-full border-2 border-[#14213d] bg-[#216a38] px-3 py-2 text-white">✓ FORECAST-PERMITTED</li>
          <li className="rounded-full border-2 border-[#14213d] bg-[#ffc53d] px-3 py-2">☀ FIELD CHECK</li>
          <li className="rounded-full border-2 border-[#14213d] bg-[#d1433f] px-3 py-2 text-white">× BLOCKED</li>
        </ul>
      </div>

      <p className="mt-3 max-w-3xl font-semibold text-[#14213d]/75">
        <span className="hidden md:inline">Hours are Eastern time. Use the arrow keys to move between hours. Each product lane shows which label controls an hour.</span>
        <span className="md:hidden">Hours are Eastern time. Open a day to review its runs. Tap a run to see the forecast and exact label clauses.</span>
      </p>

      <div className="mt-5 space-y-5">
        {groups.map((group, groupIndex) => {
          const runs = groupRuns(group.hours);
          return (
            <section
              key={group.key}
              data-day={group.key}
              data-day-hours={group.hours.length}
              className="min-w-0 overflow-hidden rounded-[1.6rem] border-[3px] border-[#14213d] bg-[#fbf7ee] shadow-[5px_6px_0_#14213d]"
            >
              <h3 className="hidden border-b-[3px] border-[#14213d] bg-[#9fd3f2] px-4 py-2 font-extrabold md:block">
                {group.label}
              </h3>

              <div className="hidden min-w-0 p-2 md:block" aria-label={`${group.label} timeline`}>
                <div className="timeline-grid grid min-w-0">
                  <span className="self-center truncate pr-1 text-[0.58rem] font-extrabold uppercase tracking-[0.04em] lg:text-xs lg:tracking-[0.1em]">Combined</span>
                  {group.hours.map(({ hour, index }) => (
                    <button
                      key={hour.start}
                      ref={(node) => { refs.current[index] = node; }}
                      id={`forecast-hour-${index}`}
                      type="button"
                      data-hour-cell
                      data-state={displayState(hour.state)}
                      aria-label={accessibleHourName(hour)}
                      aria-pressed={selectedIndex === index}
                      onClick={() => onSelect(index)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                          event.preventDefault();
                          moveFocus(index, 1);
                        }
                        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                          event.preventDefault();
                          moveFocus(index, -1);
                        }
                        if (event.key === "Home") {
                          event.preventDefault();
                          moveFocus(index, -index);
                        }
                        if (event.key === "End") {
                          event.preventDefault();
                          moveFocus(index, hours.length - 1 - index);
                        }
                      }}
                      style={{ gridColumn: localHour(hour.start) + 2 }}
                      className={`grid min-h-14 min-w-0 place-content-center overflow-hidden rounded-md border px-px text-center outline-offset-1 transition-transform focus-visible:z-10 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d] ${stateClass(hour.state)} ${selectedIndex === index ? "z-10 -translate-y-1 ring-2 ring-[#14213d]" : "hover:-translate-y-0.5"}`}
                    >
                      <span aria-hidden="true" className="block text-xs font-black leading-none lg:text-sm">{stateIcon(hour.state)}</span>
                      <span aria-hidden="true" className="timeline-state-word mt-1 text-[0.48rem] font-black leading-none">{abbreviation(hour.state)}</span>
                      <span aria-hidden="true" className="mt-1 block text-[0.52rem] font-bold leading-none lg:text-[0.58rem]">{compactHourLabel(hour.start)}</span>
                    </button>
                  ))}
                </div>

                {products.map((product) => (
                  <ProductLane key={product.fullName} product={product} entries={group.hours} />
                ))}
              </div>

              <details className="md:hidden" open={group.key === today || (!hasToday && groupIndex === 0)}>
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 bg-[#9fd3f2] px-4 py-2 font-extrabold outline-offset-[-4px] marker:hidden focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d]">
                  <span>{group.label}</span>
                  <span className="text-xs">{runs.length} {runs.length === 1 ? "run" : "runs"}</span>
                </summary>
                <div className="p-3">
                  <div aria-hidden="true" className="grid grid-cols-24 overflow-hidden rounded-lg border-2 border-[#14213d]">
                    {Array.from({ length: 24 }, (_, column) => {
                      const entry = group.hours.find(({ hour }) => localHour(hour.start) === column);
                      return (
                        <span
                          key={column}
                          className={`flex h-6 min-w-0 items-center justify-center text-[0.42rem] font-black leading-none ${entry ? summaryStateClass(entry.hour.state) : "bg-[#14213d]/8 text-transparent"}`}
                        >
                          {entry ? stateIcon(entry.hour.state) : "·"}
                        </span>
                      );
                    })}
                  </div>

                  <ol className="mt-3 space-y-2">
                    {runs.map((run) => {
                      const first = run.entries[0];
                      const citation = bindingCitations(first.hour)[0];
                      return (
                        <li key={first.hour.start}>
                          <button
                            type="button"
                            data-run-row
                            aria-pressed={selectedIndex === first.index}
                            onClick={() => onSelect(first.index)}
                            className={`flex min-h-[44px] w-full items-start gap-3 rounded-xl border-2 border-[#14213d] px-3 py-3 text-left outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d] ${selectedIndex === first.index ? "bg-[#9fd3f2]/45 ring-2 ring-[#14213d]" : "bg-white"}`}
                          >
                            <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-black ${stateClass(first.hour.state)}`}>
                              {stateIcon(first.hour.state)}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-black leading-snug">{runLabel(run)}</span>
                              {run.bindingProducts.length > 0 && (
                                <span className="mt-1 block break-words text-xs font-semibold leading-snug text-[#14213d]/75">
                                  {run.bindingProducts.map((product) => productNames.get(product) ?? product).join(", ")}
                                  {citation?.why ? `: ${citation.why}` : ""}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </details>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function ProductLane({ product, entries }: {
  product: { fullName: string; shortName: string; reg?: string };
  entries: HourEntry[];
}) {
  const description = product.reg
    ? `${product.fullName}, EPA Reg. ${product.reg}`
    : product.fullName;
  return (
    <div className="timeline-grid mt-1 grid min-w-0">
      <span
        className="self-center truncate pr-1 text-[0.55rem] font-bold lg:text-xs"
        title={description}
        aria-label={description}
      >
        {product.shortName}
      </span>
      {entries.map(({ hour }) => {
        const state = productState(hour, product.fullName);
        return (
          <span
            key={`${product.fullName}-${hour.start}`}
            title={`${description}: ${state === "blocked" ? "BLOCKED" : state === "check" ? "FIELD CHECK" : "No controlling clause"}`}
            style={{ gridColumn: localHour(hour.start) + 2 }}
            className={`flex min-h-6 min-w-0 items-center justify-center overflow-hidden rounded-sm border text-[0.55rem] font-black ${
              state === "blocked"
                ? "border-[#9f2926] bg-[#d1433f] text-white"
                : state === "check"
                  ? "border-[#8a5a2b] bg-[#ffc53d] text-[#14213d]"
                  : "border-[#14213d]/15 bg-[#14213d]/5 text-[#14213d]/35"
            }`}
          >
            <span aria-hidden="true">{state === "blocked" ? "B" : state === "check" ? "☀" : "·"}</span>
            <span className="sr-only">{state === "blocked" ? "Blocked" : state === "check" ? "Field check" : "No controlling clause"}</span>
          </span>
        );
      })}
    </div>
  );
}
