import checkback from "../../public/data/checkback.json";

type Pooled = {
  held: number;
  broke: number;
  permitted_a_day_ahead: number;
  breaks: Array<{ count: number; rule: string; product: string; param: string; unit?: string; observed_min?: number; observed_max?: number; limit?: { upper_mph?: number | null; lower_mph?: number | null } }>;
  skipped: { missing_measurement: number; no_issuance: number; no_obs: number };
};

type Scenario = {
  product: string;
  pooled: Pooled;
  not_checkable_clauses: Array<{ rule: string; reason: string }>;
};

type CheckBack = {
  command: string;
  recorded_span: { first: string; last: string };
  stations: Array<{ stationId: string; stationName: string }>;
  tank_mix: Scenario;
  products: Record<string, Scenario>;
};

const data = checkback as unknown as CheckBack;

const ROWS: Array<{ key: string; label: string; scenario: Scenario }> = [
  { key: "tank", label: "All three in the tank", scenario: data.tank_mix },
  { key: "5481-504", label: "Folex 6 EC alone", scenario: data.products["5481-504"] },
  { key: "264-700", label: "Dropp SC alone", scenario: data.products["264-700"] },
  { key: "264-418", label: "Prep alone", scenario: data.products["264-418"] },
];

// Held and broke are the two states of one checked hour. Green is the planner's own
// "permitted" color; amber marks a label limit the station saw exceeded. The pair passes the
// dataviz palette validator (protan delta E 19.7); red on green failed it (1.1).
const HELD = "#216a38";
const BROKE = "#e0912c";

const spanFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// The recorded command carries a Windows path to the local recording; print the repo-relative form.
const RECOMPUTE = "python tools/checkback.py --recorded data/nws_recorded";

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "n/a";
}

function mph(value: number | undefined): string {
  return value === undefined ? "" : `${value.toFixed(1)} mph`;
}

export function ForecastCheckBack() {
  const tank = data.tank_mix.pooled;
  const checked = tank.held + tank.broke;
  const topBreak = tank.breaks[0];
  // The summary can list one rule twice (two quotes of the same clause), so count rule ids.
  const notCheckable = new Set(data.tank_mix.not_checkable_clauses.map((clause) => clause.rule)).size;
  const windOnly = tank.breaks.length > 0 && tank.breaks.every((entry) => entry.param === "wind_speed_mph");

  return (
    <div className="checkback">
      <p className="checkback-lede">
        For every recorded hour from {spanFormatter.format(new Date(data.recorded_span.first))} to {spanFormatter.format(new Date(data.recorded_span.last))} Eastern,
        the planner ran on the forecast issued about 24 hours earlier. Where it said forecast-permitted, the label limits an
        airport weather station can measure were checked against what the station observed in that hour.
      </p>

      <p className="checkback-headline">
        <span className="display checkback-number">{tank.held} of {checked}</span>
        <span>checked tank-mix hours held up ({percent(tank.held, checked)}).</span>
      </p>

      <div className="checkback-legend" aria-hidden="true">
        <span><i style={{ background: HELD }} /> held: every station-checkable limit was met</span>
        <span><i style={{ background: BROKE }} /> broke: the station saw a limit exceeded</span>
      </div>

      <ul className="checkback-rows">
        {ROWS.map(({ key, label, scenario }) => {
          const { held, broke } = scenario.pooled;
          const total = held + broke;
          const summary = `${label}: ${held} held, ${broke} broke, of ${total} checked hours`;
          return (
            <li key={key} className="checkback-row" data-checkback-row={key}>
              <span className="checkback-row-label">{label}</span>
              <span className="checkback-bar" role="img" aria-label={summary} title={summary}>
                <span className="checkback-seg" style={{ width: `${(held / total) * 100}%`, background: HELD }} />
                <span className="checkback-seg" style={{ width: `${(broke / total) * 100}%`, background: BROKE }} />
              </span>
              <span className="checkback-row-value">{held} held · {broke} broke</span>
            </li>
          );
        })}
      </ul>

      {topBreak && windOnly ? (
        <p className="checkback-why">
          Every broken tank-mix hour broke on wind: the station measured {mph(topBreak.observed_min)} to {mph(topBreak.observed_max)} where the
          labels allow at most {topBreak.limit?.upper_mph ?? 10} mph ({tank.breaks.length} wind clauses across the three labels). A day-ahead
          forecast is a plan, not a measurement: re-run the planner close to spray time, and measure wind at the boom as the labels require.
        </p>
      ) : null}

      <p className="checkback-source">
        {notCheckable} tank-mix clauses cannot be checked from a station (temperature inversions, rain expected within hours, the night-low tank
        rule) and are never counted as held. {tank.skipped.no_obs + tank.skipped.no_issuance + tank.skipped.missing_measurement} hours had no
        observation, no forecast from a day earlier, or no wind reading, and are left out. Stations: {data.stations.map((station) => `${station.stationName} (${station.stationId})`).join(", ")}.
        {" "}Recompute with <code>{RECOMPUTE}</code> on the recording; full detail in{" "}
        <a className="text-link" href="https://github.com/StephenSook/labelhand/tree/main/eval/results">eval/results</a>.
      </p>

      <table className="sr-only">
        <caption>Forecast check-back, hours permitted a day ahead and checked against the station</caption>
        <thead><tr><th scope="col">Tank</th><th scope="col">Held</th><th scope="col">Broke</th><th scope="col">Checked</th></tr></thead>
        <tbody>
          {ROWS.map(({ key, label, scenario }) => (
            <tr key={key}><th scope="row">{label}</th><td>{scenario.pooled.held}</td><td>{scenario.pooled.broke}</td><td>{scenario.pooled.held + scenario.pooled.broke}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
