import type { Metadata } from "next";
import Link from "next/link";
import { pointName } from "@/lib/planner-data";
import { Chip, Nav, SectionCard } from "@/ui";
import modelAlone from "../../../public/data/model-alone.json";
import proof from "../../../public/data/proof.json";

export const metadata: Metadata = { title: "Proof: every graded case, misses included" };

type Rule = { id: string; param: string; op: string | null; value: number | null; unit: string | null; modality: string; page: number | null; quote: string; acting: boolean };

type GoldRow = {
  id: string;
  reg: string;
  pages: number[];
  key: string;
  param: string;
  value: number | null;
  unit: string | null;
  modality: string;
  planner_must_enforce: boolean;
  verdict: "matched" | "missed" | "wrong_parameter";
  got_params?: string[];
  rules?: Rule[];
  modality_ok?: boolean;
  value_ok?: boolean | null;
  enforced?: boolean;
};

type Product = { name: string; accepted: string; url: string; gold: number; coverage: number; gold_acting: number; gold_acting_hit: number };

type Miss = { point: string; hour_utc: string; forecast_issued_utc: string; station_id: string; observed_utc: string; wind_mph: number; broken: string[] };

type BrokenRule = { reg: string; page: number | null; param: string; quote: string; limit: { upper_mph?: number | null } | null };

type Proof = {
  products: Record<string, Product>;
  gold: GoldRow[];
  checkback: { recorded_span: { first: string; last: string }; held: number; broke: number; misses: Miss[]; rules: Record<string, BrokenRule>; stations: Record<string, string> };
};

const data = proof as unknown as Proof;

type MatrixRow = { PERMITTED: number; BLOCKED: number; FIELD_CHECK: number };
type ModelAlone = {
  model: string;
  pooled: {
    successful_cases: number;
    hours_compared: number;
    agreement_matrix_model_x_planner: { PERMITTED: MatrixRow; BLOCKED: MatrixRow; FIELD_CHECK: MatrixRow };
    quote_check: { matched: number; total: number };
    against_observations: { model_permitted: { held: number; broke: number }; planner_permitted: { held: number; broke: number } };
    model_calls: { attempts: number; latency_ms: number; cost_usd: number };
  };
  unsafe_go_hours: Array<{
    point: string;
    time: string;
    model_reason: string;
    model_citation: { registration: string; page: number; sentence: string };
    planner_rules: Array<{ rule_id: string; product: string; page: number; why: string }>;
  }>;
};
const alone = modelAlone as unknown as ModelAlone;
const ACTING = new Set(["MUST", "MUST_NOT"]);
const TANK = "5481-504,264-700,264-418";

const hourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
const issuedFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function modalityText(modality: string): string {
  return modality === "MUST_NOT" ? "MUST NOT" : modality;
}

function amount(value: number | null, unit: string | null): string {
  if (value === null) return "no number";
  if (unit === "%" || unit === "pct") return `${value}%`;
  return unit && unit !== "none" ? `${value} ${unit}` : String(value);
}

// A clause can match several rules (two quotes of one sentence). Show the one that agrees with the
// gold set where one does, so a row never looks wrong when the scorer counted it right.
function shownRule(row: GoldRow): Rule | undefined {
  const rules = row.rules ?? [];
  const valueAgrees = (rule: Rule) => row.value === null || (rule.value !== null && Number(rule.value) === Number(row.value));
  return (
    rules.find((rule) => rule.modality === row.modality && valueAgrees(rule)) ??
    rules.find((rule) => rule.modality === row.modality) ??
    rules.find(valueAgrees) ??
    rules[0]
  );
}

function pdfHref(reg: string, page: number | null | undefined): string {
  const url = data.products[reg]?.url ?? "";
  return page ? `${url}#page=${page}` : url;
}

// What a difference from the gold set does to an hour, read from the two modalities and from
// whether the planner acts on the compiled rule (rule.acting, computed by tools/proof_export.py).
function effect(row: GoldRow, rule: Rule): string {
  const hours = rule.acting ? "The planner acts on this rule." : "This rule does not decide any forecast hour.";
  if (!row.modality_ok) {
    if (ACTING.has(row.modality) && ACTING.has(rule.modality)) {
      return `Both are binding: one states what is forbidden, the other what must hold. ${hours}`;
    }
    if (row.modality === "ADVISORY" && ACTING.has(rule.modality)) {
      return `The rule is stricter than the gold set. ${hours}`;
    }
    if (ACTING.has(row.modality) && rule.modality === "ADVISORY") {
      return "The rule is weaker than the label: this is the kind of miss that would mark a forbidden hour as permitted.";
    }
  }
  if (row.value_ok === false) {
    return rule.value === null
      ? "The rule kept the sentence but not its number, so it cannot be checked against a measurement."
      : "The rule kept a different number from the same sentence.";
  }
  return "";
}

function differs(row: GoldRow): boolean {
  return row.verdict !== "matched" || row.modality_ok === false || row.value_ok === false;
}

function missesByDay(misses: Miss[]): Array<{ day: string; label: string; rows: Miss[] }> {
  const groups = new Map<string, Miss[]>();
  for (const miss of misses) {
    const key = dayKey.format(new Date(miss.hour_utc));
    groups.set(key, [...(groups.get(key) ?? []), miss]);
  }
  return [...groups.entries()].map(([day, rows]) => ({ day, label: dayFormatter.format(new Date(rows[0].hour_utc)), rows }));
}

export default function ProofPage() {
  const gold = data.gold;
  const different = gold.filter(differs);
  const modalityDiffers = gold.filter((row) => row.modality_ok === false).length;
  const valueDiffers = gold.filter((row) => row.value_ok === false).length;
  const found = gold.filter((row) => row.verdict !== "missed").length;
  const mustEnforce = gold.filter((row) => row.planner_must_enforce);
  const enforced = mustEnforce.filter((row) => row.enforced).length;
  const { held, broke, misses, rules, stations } = data.checkback;
  const days = missesByDay(misses);
  const brokenRules = Object.entries(rules);
  const windOnly = brokenRules.length > 0 && brokenRules.every(([, rule]) => rule.param === "wind_speed_mph");
  const regs = ["5481-504", "264-700", "264-418"].filter((reg) => reg in data.products);
  const matrix = alone.pooled.agreement_matrix_model_x_planner;
  const modelGo = matrix.PERMITTED.PERMITTED + matrix.PERMITTED.BLOCKED + matrix.PERMITTED.FIELD_CHECK;
  const plannerGo = matrix.PERMITTED.PERMITTED + matrix.BLOCKED.PERMITTED + matrix.FIELD_CHECK.PERMITTED;
  const calls = alone.pooled.model_calls;

  return (
    <>
      <Nav />
      <main className="page-shell">
        <SectionCard className="proof-hero" tone="sun">
          <p className="hand">misses first</p>
          <h1 className="display proof-title">Every graded case</h1>
          <p className="proof-lede">
            Three checks, run on committed data. Every case is listed here, including the ones Labelhand got wrong, so you can check the counts
            yourself instead of trusting a percentage.
          </p>
          <div className="proof-tally">
            <a className="proof-tally-item" href="#label-clauses">
              <span className="display proof-tally-number">{found} of {gold.length}</span>
              <span>
                gold-set label clauses found by the shipped rules. {modalityDiffers} carry a different modality and {valueDiffers} a different number;
                {" "}{enforced} of {mustEnforce.length} clauses the planner must enforce are enforced.
              </span>
            </a>
            <a className="proof-tally-item" href="#model-alone">
              <span className="display proof-tally-number">{matrix.PERMITTED.BLOCKED}</span>
              <span>
                hours where Nemotron, handed the same three labels and forecast with no compiled rules, said go and the labels block the hour.
              </span>
            </a>
            <a className="proof-tally-item" href="#forecast-misses">
              <span className="display proof-tally-number">{broke}</span>
              <span>
                tank-mix hours the day-ahead forecast permitted and the airport station then saw a label limit exceeded, out of {held + broke} checked.
              </span>
            </a>
          </div>
        </SectionCard>

        <SectionCard className="proof-card" id="label-clauses">
          <h2 className="display proof-heading">Label clauses against the gold set</h2>
          <p className="proof-text">
            The gold set is {gold.length} clauses the planner relies on, annotated by us from the EPA label text of {regs.map((reg) => data.products[reg].name).join(", ")}.
            No outside reviewer has checked it yet. Each clause is matched to the shipped rules by its exact sentence, the same way{" "}
            <code>eval/score.py</code> scores them.
          </p>

          <h3 className="proof-subheading">Where the rules differ from the gold set</h3>
          <ul className="proof-diffs">
            {different.map((row) => {
              const rule = shownRule(row);
              const note = rule ? effect(row, rule) : "";
              return (
                <li className="proof-diff" key={row.id} data-proof-diff={row.id}>
                  <div className="proof-diff-head">
                    <Chip tone={row.verdict === "matched" ? "sun" : "red"}>{row.id}</Chip>
                    <a className="text-link" href={pdfHref(row.reg, row.pages[0])} target="_blank" rel="noreferrer">
                      {data.products[row.reg].name}, page {row.pages.join(", ")}
                    </a>
                  </div>
                  <blockquote className="proof-quote">{rule?.quote ?? row.key}</blockquote>
                  {row.verdict === "matched" && rule ? (
                    <dl className="proof-compare">
                      <div>
                        <dt>Gold set</dt>
                        <dd>{modalityText(row.modality)}, {amount(row.value, row.unit)}</dd>
                      </div>
                      <div>
                        <dt>Compiled rule <code>{rule.id}</code></dt>
                        <dd>{modalityText(rule.modality)}, {amount(rule.value, rule.unit)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="proof-text">{row.verdict === "missed" ? "No shipped rule quotes this sentence." : `Found, but typed as ${row.got_params?.join(", ")}.`}</p>
                  )}
                  {note ? <p className="proof-effect">{note}</p> : null}
                </li>
              );
            })}
          </ul>

          <details className="proof-all">
            <summary>All {gold.length} clauses</summary>
            <div className="proof-table-wrap">
              <table className="proof-table">
                <caption className="sr-only">Every gold-set clause and the shipped rule that matched it</caption>
                <thead>
                  <tr>
                    <th scope="col">Clause</th>
                    <th scope="col">Label sentence</th>
                    <th scope="col">Gold set</th>
                    <th scope="col">Compiled</th>
                  </tr>
                </thead>
                <tbody>
                  {gold.map((row) => {
                    const rule = shownRule(row);
                    return (
                      <tr key={row.id} className={differs(row) ? "proof-row-differs" : undefined}>
                        <th scope="row">
                          {row.id}
                          <span className="proof-row-product">{data.products[row.reg].name}, p. {row.pages.join(", ")}</span>
                        </th>
                        <td>{row.key}</td>
                        <td>{modalityText(row.modality)}, {amount(row.value, row.unit)}</td>
                        <td>{rule ? `${modalityText(rule.modality)}, ${amount(rule.value, rule.unit)}` : "missed"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </SectionCard>

        <SectionCard className="proof-card" id="model-alone">
          <h2 className="display proof-heading">Nemotron alone on the same forecasts</h2>
          <p className="proof-text">
            Why compile the labels at all? <code>{alone.model}</code> got the full text of all three labels and a recorded 48-hour NWS forecast,
            with no compiled rules, and was asked for every hour&apos;s state and the label sentence behind it. {alone.pooled.successful_cases} recorded
            forecasts from ten Georgia points, {alone.pooled.hours_compared.toLocaleString("en-US")} hours, compared with the planner on the same
            forecasts. The design was written into the receipt before the first call.
          </p>
          <dl className="proof-compare proof-alone">
            <div>
              <dt>Hours marked forecast-permitted</dt>
              <dd>Nemotron alone {modelGo}, compiled rules {plannerGo}</dd>
            </div>
            <div>
              <dt>Said go on an hour the labels block</dt>
              <dd>{matrix.PERMITTED.BLOCKED}</dd>
            </div>
            <div>
              <dt>Said go where the forecast cannot decide</dt>
              <dd>{matrix.PERMITTED.FIELD_CHECK} (in this run, all were possible temperature inversion hours)</dd>
            </div>
            <div>
              <dt>Cited sentences found on the cited page</dt>
              <dd>{alone.pooled.quote_check.matched.toLocaleString("en-US")} of {alone.pooled.quote_check.total.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Go hours checked against the station, held and broke</dt>
              <dd>Nemotron alone {alone.pooled.against_observations.model_permitted.held} and {alone.pooled.against_observations.model_permitted.broke}; compiled rules {alone.pooled.against_observations.planner_permitted.held} and {alone.pooled.against_observations.planner_permitted.broke}</dd>
            </div>
            <div>
              <dt>Cost and time per field check</dt>
              <dd>${(calls.cost_usd / calls.attempts).toFixed(3)} and {Math.round(calls.latency_ms / calls.attempts / 1000)} s on Token Factory, against no model call for the planner</dd>
            </div>
          </dl>

          <h3 className="proof-subheading">The hours Nemotron alone said go and the labels block</h3>
          <ul className="proof-diffs">
            {alone.unsafe_go_hours.map((hour) => (
              <li className="proof-diff" key={`${hour.point}-${hour.time}`} data-unsafe-hour>
                <div className="proof-diff-head">
                  <Chip tone="red">{pointName(hour.point, {})}</Chip>
                  <span>{dayFormatter.format(new Date(hour.time))}, {hourFormatter.format(new Date(hour.time))} Eastern</span>
                </div>
                <dl className="proof-compare">
                  <div>
                    <dt>Nemotron alone</dt>
                    <dd>{hour.model_reason}</dd>
                  </div>
                  <div>
                    <dt>Planner</dt>
                    <dd>BLOCKED: {hour.planner_rules[0]?.why} ({hour.planner_rules[0]?.product}, page {hour.planner_rules[0]?.page})</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="proof-text proof-caveat">
            One model, one prompt, one run at temperature 0. Neither side is the ground truth: station wind also broke many of the planner&apos;s go hours,
            because the forecast itself was wrong. Full detail per hour:{" "}
            <a className="text-link" href="https://github.com/StephenSook/labelhand/blob/main/eval/results/model-alone-2026-10-19.json">eval/results/model-alone-2026-10-19.json</a>.
          </p>
        </SectionCard>

        <SectionCard className="proof-card" id="forecast-misses">
          <h2 className="display proof-heading">Every forecast hour that broke</h2>
          <p className="proof-text">
            For each recorded hour, the planner ran on the NWS forecast issued about 24 hours earlier. Where it said forecast-permitted for all three
            products in the tank, the nearest airport station&apos;s observation for that hour was checked against the label limits a station can
            measure. {held} hours held and {broke} broke.{" "}
            {windOnly ? `Every break was wind, against these ${brokenRules.length} clauses:` : `The breaks came from these ${brokenRules.length} clauses:`}
          </p>
          <ul className="proof-rules">
            {brokenRules.map(([id, rule]) => (
              <li key={id}>
                <a className="text-link" href={pdfHref(rule.reg, rule.page)} target="_blank" rel="noreferrer">
                  {data.products[rule.reg]?.name ?? rule.reg}, page {rule.page}
                </a>
                {rule.limit?.upper_mph ? <span className="proof-limit">at most {rule.limit.upper_mph} mph</span> : null}
                <q>{rule.quote}</q>
              </li>
            ))}
          </ul>
          <p className="proof-text proof-caveat">
            An airport station is not the field: it reports a two-minute average at 10 meters, while the labels mean wind at the application site.
            Open any row to see the forecast that permitted the hour, replayed through the same planner.
          </p>

          {days.map((group) => (
            <details className="proof-day" key={group.day} data-proof-day={group.day}>
              <summary>
                <span className="proof-day-label">{group.label}</span>
                <span className="proof-day-count">{group.rows.length} {group.rows.length === 1 ? "hour" : "hours"}</span>
              </summary>
              <div className="proof-table-wrap">
                <table className="proof-table">
                  <caption className="sr-only">Hours on {group.label} the day-ahead forecast permitted and the station saw a limit exceeded</caption>
                  <thead>
                    <tr>
                      <th scope="col">Hour (Eastern)</th>
                      <th scope="col">Field</th>
                      <th scope="col">Station wind</th>
                      <th scope="col">Forecast that said go</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((miss) => (
                      <tr key={`${miss.point}-${miss.hour_utc}`}>
                        <th scope="row">{hourFormatter.format(new Date(miss.hour_utc))}</th>
                        <td>{pointName(miss.point, {})}</td>
                        <td>
                          <strong>{miss.wind_mph.toFixed(1)} mph</strong>
                          <span className="proof-row-product">{stations[miss.station_id] ?? miss.station_id} ({miss.station_id})</span>
                        </td>
                        <td>
                          <Link
                            className="text-link"
                            href={`/app?field=${miss.point}&products=${TANK}&hours=3&issued=${encodeURIComponent(miss.forecast_issued_utc)}#season-replay`}
                          >
                            Issued {issuedFormatter.format(new Date(miss.forecast_issued_utc))}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}

          <p className="proof-source">
            Recompute: <code>python tools/proof_export.py</code> rebuilds this page&apos;s data from <code>eval/gold_v0.json</code>, the shipped{" "}
            <code>.ship</code> rules and <code>eval/results/checkback-2026-10-19.json</code>. CI fails if the committed copy is stale.
          </p>
        </SectionCard>
      </main>
    </>
  );
}
