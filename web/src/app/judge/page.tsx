import type { Metadata } from "next";
import buildInfo from "@/engine/build-info.json";
import { Chip, JudgeDoor, Nav, SectionCard, type JudgeStep } from "@/ui";

export const metadata: Metadata = { title: "Judges: three-minute route" };

const plannerLink = "/app?field=tift&tank=all";

const steps: JudgeStep[] = [
  {
    title: "Run the recorded Tift forecast",
    body: (
      <p>
        Open the planner with all three products and the recorded Tift forecast. The page labels the source RECORDED and shows its fetch time. No network forecast is needed for this route.
      </p>
    ),
    href: `${plannerLink}&replay=tift`,
    action: "Open the recorded route",
  },
  {
    title: "Open a blocked hour",
    body: (
      <p>
        Select a BLOCKED hour in the timeline. Read the product, page, exact label quote, and the planner&apos;s reason. Follow the page link to the EPA label.
      </p>
    ),
    href: `${plannerLink}&replay=tift#timeline`,
    action: "Go to the timeline",
  },
  {
    title: "Run a real what-if",
    body: (
      <p>
        Open &quot;Why so few windows?&quot; and press &quot;Check without PREP BRAND ETHEPHON FOR COTTON AND TOBACCO&quot;. The same WebAssembly planner reruns on the recorded forecast and returns 31 forecast-permitted hours in five windows. It makes no new network call.
      </p>
    ),
    href: `${plannerLink}&replay=tift#few-windows-heading`,
    action: "Try the what-if",
  },
  {
    title: "Inspect every rule in the tank",
    body: (
      <p>
        Open &quot;Rules in this tank&quot;. The planner separates rules it used from rules skipped by the topic check, and gives the reason for each skipped rule.
      </p>
    ),
    href: `${plannerLink}&replay=tift#rules-in-tank`,
    action: "See the rule receipt",
  },
  {
    title: "Check the measured compiler results",
    body: (
      <p>
        The repository reports coverage, typed recall, value accuracy, modality accuracy, acting precision, and acting recall against its committed gold set.
      </p>
    ),
    href: "https://github.com/StephenSook/labelhand#measured-so-far",
    action: "Read the measured table on GitHub",
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
          <h1 className="display judge-title">Judges: three minutes</h1>
          <p className="judge-lede">Run one recorded forecast, inspect the clauses behind it, then rerun a real tank what-if.</p>
          <JudgeDoor steps={steps} />
        </SectionCard>

        <SectionCard className="deployment-card" tone="ink">
          <p className="hand">we only claim what is on</p>
          <h2 className="display">What is live on this deployment right now</h2>
          <ul className="deployment-list">
            <li>
              <Chip icon="↗" tone="field">ON CHECK</Chip>
              <div>
                <strong>National Weather Service hourly forecast</strong>
                <p>The planner fetches it from api.weather.gov in your browser when you press Check.</p>
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
                  The deployed <code>.ship</code> set takes a majority modality vote across three measured p2, typing v3, OCR and modality-floor runs. <code>eval/results/ship.json</code> records 1.0 coverage recall, 1.0 strict acting precision (12/12) and 1.0 acting recall (10/10).
                </p>
              </div>
            </li>
            <li>
              <Chip icon="C" tone="field">KERNEL</Chip>
              <div>
                <strong>Temperature clauses that require one product alone are checked against the tank.</strong>
                <p>
                  A matching clause blocks only when its temperature condition holds and another product is present. On the recorded Tift forecast, the night low never falls below 60 F. The majority set gives all three products 17 permitted, 63 field check and 76 blocked; Folex alone has 31 permitted, 54 field check and 71 blocked; Dropp plus Prep has 17 permitted, 63 field check and 76 blocked.
                </p>
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
