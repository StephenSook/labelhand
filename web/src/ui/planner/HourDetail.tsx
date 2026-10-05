import { Stamp } from "@/ui";
import { ShowOnLabel, type LabelSource } from "@/ui/ShowOnLabel";
import type { SprayRecordInput } from "@/lib/spray-record";
import {
  displayState,
  type Citation,
  type LabelIndex,
  type PlannerHour,
  type PlannerRule,
} from "@/lib/planner-data";
import { SprayRecordButton } from "./SprayRecordButton";

type HourDetailProps = {
  hour: PlannerHour;
  labels: LabelIndex;
  usedRules: PlannerRule[];
  sprayRecord?: SprayRecordInput;
};

const detailTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  timeZoneName: "short",
});

function shown(value: unknown, suffix = ""): string {
  return value === null || value === undefined || value === "" ? "Not supplied" : `${String(value)}${suffix}`;
}

function labelSource(citation: Citation, labels: LabelIndex, rules: PlannerRule[]): LabelSource | null {
  const rule = rules.find((candidate) => candidate.id === citation.rule && candidate.product === citation.product);
  const page = Number(citation.page);
  if (!Number.isInteger(page) || page < 1) return null;
  if (rule?.reg && labels[rule.reg]) {
    const label = labels[rule.reg];
    return {
      reg: rule.reg,
      product: label.product,
      accepted: label.accepted,
      url: label.url,
      page,
      quote: citation.quote,
      quoteCheck: rule.quote_check,
    };
  }
  const label = Object.values(labels).find((candidate) => candidate.product === citation.product);
  return label ? { ...label, page, quote: citation.quote } : null;
}

export function HourDetail({ hour, labels, usedRules, sprayRecord }: HourDetailProps) {
  const stampState = displayState(hour.state);
  return (
    <section id="hour-detail" aria-labelledby="hour-detail-heading" className="mt-8 scroll-mt-28 rounded-[2rem] border-[3px] border-[#14213d] bg-white p-5 shadow-[6px_8px_0_#14213d] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-extrabold uppercase tracking-[0.13em] text-[#8a5a2b]">Selected hour</p>
          <h2 id="hour-detail-heading" className="display mt-1 text-3xl sm:text-4xl">
            {detailTime.format(new Date(hour.start))}
          </h2>
        </div>
        <Stamp state={stampState}>{stampState}</Stamp>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <WeatherFact term="Temperature" value={shown(hour.temp_f, "°F")} />
        <WeatherFact term="Wind" value={shown(hour.wind)} />
        <WeatherFact term="Rain chance" value={shown(hour.pop, "%")} />
        <WeatherFact term="Sun altitude" value={`${hour.sun_alt.toFixed(1)}°`} />
      </dl>

      {sprayRecord ? <SprayRecordButton input={sprayRecord} className="mt-5" /> : null}

      <CitationSection
        title="Blocking clauses"
        empty="No blocking clause controls this hour."
        citations={hour.blocked}
        kind="blocked"
        labels={labels}
        usedRules={usedRules}
      />
      <CitationSection
        title="Field checks"
        empty="No on-site check was raised for this hour."
        citations={hour.checks}
        kind="check"
        labels={labels}
        usedRules={usedRules}
      />
      <CitationSection
        title="Advisories"
        empty="No advisory was raised for this hour."
        citations={hour.advisories}
        kind="advisory"
        labels={labels}
        usedRules={usedRules}
      />
    </section>
  );
}

function WeatherFact({ term, value }: { term: string; value: string }) {
  return (
    <div className="rounded-2xl border-2 border-[#14213d] bg-[#fbf7ee] px-3 py-3">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-[#14213d]/65">{term}</dt>
      <dd className="mt-1 text-lg font-black">{value}</dd>
    </div>
  );
}

function CitationSection({ title, empty, citations, kind, labels, usedRules }: {
  title: string;
  empty: string;
  citations: Citation[];
  kind: "blocked" | "check" | "advisory";
  labels: LabelIndex;
  usedRules: PlannerRule[];
}) {
  return (
    <section className="mt-7" aria-labelledby={`citation-${kind}`}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 id={`citation-${kind}`} className="display text-2xl">{title}</h3>
        {kind === "advisory" && (
          <p className="text-sm font-bold text-[#14213d]/70">Advisories do not change the hour state.</p>
        )}
      </div>
      {citations.length === 0 ? (
        <p className="mt-2 text-sm font-semibold text-[#14213d]/65">{empty}</p>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {citations.map((citation, index) => {
            const source = labelSource(citation, labels, usedRules);
            return (
              <article
                data-quote-card
                key={`${kind}-${citation.rule}-${index}`}
                className={`rounded-[1.4rem] border-2 border-[#14213d] p-4 ${
                  kind === "blocked" ? "bg-[#d1433f]/10" : kind === "check" ? "bg-[#ffc53d]/25" : "bg-[#9fd3f2]/25"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-black">{citation.product}</p>
                  <span className="rounded-full border-2 border-[#14213d] bg-white px-2.5 py-1 text-xs font-extrabold">Page {String(citation.page)}</span>
                </div>
                <p className="mt-3 text-xs font-extrabold uppercase tracking-[0.11em] text-[#14213d]/65">Exact label quote</p>
                <blockquote className="mt-1 border-l-4 border-[#8a5a2b] pl-3 font-semibold leading-relaxed">
                  {citation.quote}
                </blockquote>
                <p className="mt-3 text-sm font-bold"><span className="text-[#14213d]/60">Why: </span>{citation.why}</p>
                {source ? (
                  <ShowOnLabel
                    source={source}
                    className="mt-4 scroll-mt-28"
                    id={kind === "blocked" && index === 0 ? "show-on-label" : undefined}
                  />
                ) : (
                  <p className="mt-4 text-sm font-bold text-[#d1433f]">No EPA source URL was supplied for this product.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
