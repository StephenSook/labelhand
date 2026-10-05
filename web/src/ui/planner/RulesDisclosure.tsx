import type { FilteredRules, LabelIndex } from "@/lib/planner-data";
import { ShowOnLabel } from "@/ui/ShowOnLabel";

export function RulesDisclosure({ groups, labels }: { groups: FilteredRules[]; labels: LabelIndex }) {
  const usedCount = groups.reduce((sum, group) => sum + group.used.length, 0);
  const skippedCount = groups.reduce((sum, group) => sum + group.skipped.length, 0);

  return (
    <details id="rules-in-tank" className="mt-10 scroll-mt-28 rounded-[2rem] border-[3px] border-[#14213d] bg-[#fbf7ee] shadow-[5px_6px_0_#14213d]">
      <summary className="cursor-pointer list-none rounded-[1.8rem] px-5 py-5 outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d] sm:px-7">
        <span className="flex flex-wrap items-center justify-between gap-3">
          <span>
            <span className="display block text-3xl">Rules in this tank</span>
            <span className="mt-1 block text-sm font-bold text-[#14213d]/70">
              {usedCount} used by the planner. {skippedCount} skipped by the topic check.
            </span>
          </span>
          <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-full border-2 border-[#14213d] bg-[#ffc53d] text-2xl font-black">+</span>
        </span>
      </summary>
      <div className="border-t-[3px] border-[#14213d] p-5 sm:p-7">
        {groups.map((group) => (
          <section key={group.product} className="not-last:mb-8" aria-labelledby={`rules-${safeId(group.product)}`}>
            <h3 id={`rules-${safeId(group.product)}`} className="display text-2xl">{group.product}</h3>

            <h4 className="mt-4 text-sm font-extrabold uppercase tracking-[0.12em] text-[#236d3b]">Used by the planner</h4>
            {group.used.length === 0 ? (
              <p className="mt-2 font-semibold">No rule from this product passed the topic check.</p>
            ) : (
              <div className="mt-2 grid gap-3 lg:grid-cols-2">
                {group.used.map((rule) => {
                  const label = rule.reg ? labels[rule.reg] : undefined;
                  const page = Number(rule.page);
                  return (
                  <article data-quote-card key={`${group.product}-${rule.id}`} className="rounded-2xl border-2 border-[#14213d] bg-white p-4">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <RuleFact term="Rule" value={rule.id} />
                      <RuleFact term="Page" value={String(rule.page)} />
                      <RuleFact term="Parameter" value={rule.param} />
                      <RuleFact term="Modality" value={rule.modality} />
                    </dl>
                    <p className="mt-3 text-xs font-extrabold uppercase tracking-[0.1em] text-[#14213d]/60">Exact label quote</p>
                    <blockquote className="mt-1 border-l-4 border-[#2f8f4e] pl-3 text-sm font-semibold leading-relaxed">
                      {rule.quote}
                    </blockquote>
                    {label && Number.isInteger(page) && page > 0 ? (
                      <ShowOnLabel
                        className="mt-4"
                        source={{
                          reg: label.reg,
                          product: label.product,
                          accepted: label.accepted,
                          url: label.url,
                          page,
                          quote: rule.quote,
                          quoteCheck: rule.quote_check,
                        }}
                      />
                    ) : null}
                  </article>
                  );
                })}
              </div>
            )}

            <h4 className="mt-5 text-sm font-extrabold uppercase tracking-[0.12em] text-[#8a5a2b]">Skipped by the topic check</h4>
            {group.skipped.length === 0 ? (
              <p className="mt-2 text-sm font-semibold text-[#14213d]/70">No rules were skipped.</p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {group.skipped.map((rule) => (
                  <li key={`${group.product}-${rule.id}`} className="rounded-xl border-2 border-[#14213d]/30 bg-[#ffc53d]/15 px-3 py-2 text-sm font-semibold">
                    <span className="font-black">{rule.id}</span> · {rule.param} · {rule.why}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </details>
  );
}

function RuleFact({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-extrabold uppercase tracking-[0.08em] text-[#14213d]/55">{term}</dt>
      <dd className="break-words font-bold">{value}</dd>
    </div>
  );
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
