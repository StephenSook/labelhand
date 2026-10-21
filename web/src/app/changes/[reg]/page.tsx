import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { fileNameOf, type ChangesData } from "@/lib/label-changes";
import { labelTitle } from "@/lib/planner-data";
import { FEDERAL_REG_PATTERN } from "@/lib/ppls";
import { Nav, SectionCard } from "@/ui";
import { LabelVersions } from "@/ui/changes/LabelVersions";
import { RuleChanges } from "@/ui/changes/RuleChanges";
import changesJson from "../../../../public/data/changes.json";
import labelIndex from "../../../../public/data/labels/index.json";

const changes = changesJson as unknown as ChangesData;

type Params = Promise<{ reg: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function shippedLabel(reg: string) {
  return labelIndex.find((label) => label.reg === reg);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { reg } = await params;
  const label = shippedLabel(reg);
  return {
    title: `What changed on ${label ? label.shortName : `EPA Reg. ${reg}`}`, // the root layout's template appends "| Labelhand"
    description: "Every accepted EPA label version for one registration, and what changed between two of them, spray conditions first.",
  };
}

export default async function ChangesPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { reg } = await params;
  if (!FEDERAL_REG_PATTERN.test(reg)) notFound();
  const query = await searchParams;
  const label = shippedLabel(reg);
  const entry = changes.labels[reg];
  const title = label ? labelTitle(label) : `EPA Reg. ${reg}`;
  const committedPair = entry?.previous.url ? { from: fileNameOf(entry.previous.url), to: fileNameOf(entry.shipped.url) } : undefined;

  return (
    <>
      <Nav />
      <main className="page-shell">
        <SectionCard className="proof-hero" tone="sun">
          <p className="hand">label time machine</p>
          <h1 className="display proof-title changes-title">What changed on {label ? label.shortName : `EPA Reg. ${reg}`}</h1>
          <p className="proof-lede">
            EPA keeps every label version it has accepted for a registration. Pick two and Labelhand compares their text, sentence by sentence, with the
            changes that touch spray conditions first. Each change opens the real PDF at its page.
          </p>
          <p className="proof-lede changes-lede-small">
            <Link className="text-link" href={label ? `/app?field=tift&products=${reg}&hours=3` : `/app?field=tift&products=none&hours=3&live=${reg}`}>
              Check this label against the forecast
            </Link>
          </p>
        </SectionCard>

        <SectionCard className="proof-card">
          <LabelVersions
            reg={reg}
            title={title}
            shippedFile={label ? fileNameOf(label.url) : undefined}
            committedPair={committedPair}
            initialFrom={first(query.from)}
            initialTo={first(query.to)}
          />
        </SectionCard>

        <SectionCard className="proof-card" id="rules">
          {entry ? (
            <RuleChanges reg={reg} entry={entry} data={changes} />
          ) : (
            <section className="changes-block" aria-labelledby="rules-heading" data-rule-changes="none">
              <h2 id="rules-heading" className="display proof-heading">Rules and planner hours</h2>
              <p className="proof-text">
                Labelhand compares compiled rules only for the three labels it ships, where it also compiled the version before the one it plans with. For this
                registration the text comparison above is the whole answer.
              </p>
            </section>
          )}
        </SectionCard>
      </main>
    </>
  );
}
