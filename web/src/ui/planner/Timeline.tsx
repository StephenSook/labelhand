"use client";

import { useMemo, useRef } from "react";
import {
  displayState,
  stateIcon,
  type PlannerHour,
} from "@/lib/planner-data";

type TimelineProps = {
  hours: PlannerHour[];
  products: string[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
};

type DayGroup = {
  key: string;
  label: string;
  hours: Array<{ hour: PlannerHour; index: number }>;
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

const shortHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
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

function abbreviation(state: PlannerHour["state"]): string {
  if (state === "BLOCKED") return "BLOCK";
  if (state === "FIELD_CHECK") return "CHECK";
  return "OK";
}

function accessibleHourName(hour: PlannerHour): string {
  const time = hourLabel.format(new Date(hour.start));
  const citation = hour.blocked[0] ?? hour.checks[0];
  if (citation) {
    const connector = hour.state === "BLOCKED" ? "by" : "for";
    return `${time}, ${displayState(hour.state)} ${connector} ${citation.product} page ${citation.page}`;
  }
  return `${time}, ${displayState(hour.state)}`;
}

function productState(hour: PlannerHour, product: string): "blocked" | "check" | "clear" {
  if (hour.blocked.some((citation) => citation.product === product)) return "blocked";
  if (hour.checks.some((citation) => citation.product === product)) return "check";
  return "clear";
}

export function Timeline({ hours, products, selectedIndex, onSelect }: TimelineProps) {
  const groups = useMemo(() => groupByDay(hours), [hours]);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

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
        Use the arrow keys to move between hours. Each product lane shows which label controls an hour.
      </p>

      <div className="mt-5 space-y-5">
        {groups.map((group) => (
          <section key={group.key} className="overflow-hidden rounded-[1.6rem] border-[3px] border-[#14213d] bg-[#fbf7ee] shadow-[5px_6px_0_#14213d]">
            <h3 className="border-b-[3px] border-[#14213d] bg-[#9fd3f2] px-4 py-2 font-extrabold">
              {group.label}
            </h3>
            <div className="overflow-x-auto p-3" tabIndex={0} aria-label={`${group.label} timeline`}>
              <div className="min-w-max">
                <div className="grid gap-1" style={{ gridTemplateColumns: `10rem repeat(${group.hours.length}, 2.75rem)` }}>
                  <span className="self-center text-xs font-extrabold uppercase tracking-[0.12em]">Combined state</span>
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
                      className={`min-h-14 rounded-xl border-2 px-0.5 text-center outline-offset-2 transition-transform focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d] ${stateClass(hour.state)} ${selectedIndex === index ? "-translate-y-1 ring-[3px] ring-[#14213d]" : "hover:-translate-y-0.5"}`}
                    >
                      <span aria-hidden="true" className="block text-base font-black leading-none">{stateIcon(hour.state)}</span>
                      <span aria-hidden="true" className="mt-1 block text-[0.58rem] font-black leading-none">{abbreviation(hour.state)}</span>
                      <span aria-hidden="true" className="mt-1 block text-[0.62rem] font-bold leading-none">{shortHour.format(new Date(hour.start))}</span>
                    </button>
                  ))}

                  {products.map((product) => (
                    <ProductLane key={product} product={product} entries={group.hours} />
                  ))}
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function ProductLane({ product, entries }: {
  product: string;
  entries: Array<{ hour: PlannerHour; index: number }>;
}) {
  return (
    <>
      <span className="self-center truncate pr-2 text-xs font-bold" title={product}>{product}</span>
      {entries.map(({ hour }) => {
        const state = productState(hour, product);
        return (
          <span
            key={`${product}-${hour.start}`}
            title={`${product}: ${state === "blocked" ? "BLOCKED" : state === "check" ? "FIELD CHECK" : "No controlling clause"}`}
            className={`flex min-h-6 items-center justify-center rounded-md border text-[0.65rem] font-black ${
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
    </>
  );
}
