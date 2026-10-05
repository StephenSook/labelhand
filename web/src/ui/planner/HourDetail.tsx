import { Stamp } from "@/ui";
import {
  displayState,
  type Citation,
  type LabelIndex,
  type PlannerHour,
  type PlannerRule,
} from "@/lib/planner-data";

type HourDetailProps = {
  hour: PlannerHour;
  labels: LabelIndex;
  usedRules: PlannerRule[];
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

function labelUrl(citation: Citation, labels: LabelIndex, rules: PlannerRule[]): string | null {
  const rule = rules.find((candidate) => candidate.id === citation.rule && candidate.product === citation.product);
  if (rule?.reg && labels[rule.reg]) return labels[rule.reg].url;
  const label = Object.values(labels).find((candidate) => candidate.product === citation.product);
  return label?.url ?? null;
}

export function HourDetail({ hour, labels, usedRules }: HourDetailProps) {
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
            const source = labelUrl(citation, labels, usedRules);
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
                  <a
                    href={`${source}#page=${encodeURIComponent(String(citation.page))}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex min-h-11 items-center rounded-full border-2 border-[#14213d] bg-white px-4 py-2 text-sm font-extrabold underline decoration-2 underline-offset-4 outline-offset-2 hover:bg-[#9fd3f2]/35 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d]"
                  >
                    Open the EPA label, page {String(citation.page)}
                  </a>
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
