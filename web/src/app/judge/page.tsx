import type { Metadata } from "next";
import Link from "next/link";
import buildInfo from "@/engine/build-info.json";
import { Chip, JudgeDoor, Nav, SectionCard, type JudgeStep } from "@/ui";
import shipEval from "../../../public/data/eval/ship.json";

export const metadata: Metadata = { title: "Judges: five-minute route" };

const plannerLink = "/app?field=tift&products=5481-504,264-700,264-418&hours=3";
const recordedLink = `${plannerLink}&replay=tift`;
const presetQuestion = "Which label sets the strictest wind limit in this tank?";

const steps: JudgeStep[] = [
  {
    title: "Run the live Tift check",
    body: (
      <p>
        The planner runs on arrival with all three products and a three-hour job. If the live NWS call is unavailable, <Link href={`${recordedLink}#next-window`}>open the recorded route</Link>.
      </p>
    ),
    href: `${plannerLink}#next-window`,
    action: "Open the live check",
  },
  {
    title: "Read a blocked hour and its clause",
    body: (
      <p>
        This link selects the first blocked hour. Read the product, page, exact label quote, and the planner&apos;s reason.
      </p>
    ),
    href: `${recordedLink}&hour=first-blocked#hour-detail`,
    action: "Open the blocked hour",
  },
  {
    title: "Show the clause on the EPA label",
    body: (
      <p>
        The selected clause includes a Show on the label button. Open the accepted EPA PDF at the cited page and inspect its highlighted text.
      </p>
    ),
    href: `${recordedLink}&hour=first-blocked#show-on-label`,
    action: "Go to Show on the label",
  },
  {
    title: "Ask the tank and read its trace",
    body: (
      <p>
        The preset asks which label sets the strictest wind limit. Run it, then open the trace for the model, latency, tokens, cost, tool calls, and guard result.
      </p>
    ),
    href: `${recordedLink}&question=${encodeURIComponent(presetQuestion)}#ask-the-tank`,
    action: "Open the preset question",
  },
  {
    title: "Run a tank what-if",
    body: (
      <p>
        Remove one product inside Why so few windows. The same WebAssembly planner reruns against the same forecast so you can compare the result.
      </p>
    ),
    href: `${recordedLink}#why-few-windows`,
    action: "Try the what-if",
  },
  {
    title: "Download the spray record",
    body: (
      <p>
        The next permitted window has a PDF spray record with the field, forecast source, products, weather, and clauses that still need a field check.
      </p>
    ),
    href: `${recordedLink}#spray-record`,
    action: "Go to the spray record",
  },
];

export default function JudgePage() {
  return (
    <>
      <Nav />
      <main className="page-shell">
        <SectionCard className="judge-hero" tone="sun">
          <Chip icon="3" tone="ink">
            No login or API key
          </Chip>
          <h1 className="display judge-title">Judges: five minutes</h1>
          <p className="judge-lede">Run the live check, inspect one clause on its label, ask the tank, then change the tank and keep the record.</p>
          <JudgeDoor steps={steps} />
        </SectionCard>

        <SectionCard className="deployment-card" tone="ink">
          <p className="hand">we only claim what is on</p>
          <h2 className="display">What is live on this deployment right now</h2>
          <ul className="deployment-list">
            <li>
              <Chip icon="↗" tone="field">ON LOAD</Chip>
              <div>
                <strong>National Weather Service hourly forecast</strong>
                <p>The planner fetches it from api.weather.gov in your browser on arrival and again when you press Check.</p>
              </div>
            </li>
            <li>
              <Chip icon="W" tone="field">SHIPPED</Chip>
              <div>
                <strong>Rust planner compiled to WebAssembly</strong>
                <p>
                  <code>{buildInfo.wasmBytes.toLocaleString("en-US")} bytes</code>
                </p>
                <p className="hash-line">
                  SHA-256 <code>{buildInfo.wasmSha256}</code>
                </p>
              </div>
            </li>
            <li>
              <Chip icon="N" tone="sky">OFFLINE</Chip>
              <div>
                <strong>Typed rules with committed quotes</strong>
                <p>
                  The rules were compiled offline by nvidia/nemotron-3-super-120b-a12b and nvidia/Nemotron-3-Ultra-550b-a55b on Nebius Token Factory.
                </p>
                <p>
                  The deployed <code>.ship</code> set takes a majority modality vote across three measured p2, typing v3, OCR and modality-floor runs. <code>eval/results/ship.json</code> records {shipEval.overall.coverage}/{shipEval.overall.gold} coverage, {shipEval.overall.acting_good}/{shipEval.overall.acting_rules} strict acting precision, and {shipEval.overall.gold_acting_hit}/{shipEval.overall.gold_acting} acting recall.
                </p>
              </div>
            </li>
            <li>
              <Chip icon="PDF" tone="field">LIVE</Chip>
              <div>
                <strong>Show on the label opens the real EPA PDF.</strong>
                <p>The cited page appears in the app, with the exact text highlighted when the PDF has a readable text layer.</p>
              </div>
            </li>
            <li>
              <Chip icon="↓" tone="field">LIVE</Chip>
              <div>
                <strong>Spray records download as PDFs.</strong>
                <p>Each record carries the checked field, forecast source, tank products, weather, and unresolved field clauses.</p>
              </div>
            </li>
            <li>
              <Chip icon="N" tone="sun">RUNTIME</Chip>
              <div>
                <strong>Ask the tank calls nvidia/Nemotron-3_5-Lightning on Nebius Token Factory at runtime.</strong>
                <p>Every call&apos;s model, latency, tokens and cost are shown in its trace.</p>
              </div>
            </li>
          </ul>
        </SectionCard>
      </main>
    </>
  );
}
