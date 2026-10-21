import {
  fileNameOf,
  formatAccepted,
  quoteForKey,
  ruleText,
  sortRuleEntries,
  type ChangesData,
  type HoursMoved,
  type LabelChangesEntry,
  type RuleEntry,
  type RuleView,
} from "@/lib/label-changes";
import { formatForecastTime } from "@/lib/planner-data";
import { Chip } from "@/ui/Chip";
import { ShowOnLabel } from "@/ui/ShowOnLabel";

const FORECAST_NAMES: Record<string, string> = {
  tift: "Tift",
  worth: "Worth",
  colquitt: "Colquitt",
  "tift-cold": "Tift, cold nights",
};

const STATE_TEXT: Record<string, string> = { PERMITTED: "forecast-permitted", BLOCKED: "blocked", FIELD_CHECK: "field check" };

function hoursText(moved: HoursMoved): string {
  if (moved.changed === 0) return `No hour changes state (0 of ${moved.hours}).`;
  const transitions = Object.entries(moved.transitions)
    .map(([key, count]) => {
      const [before, after] = key.split("->");
      return `${count} from ${STATE_TEXT[before] ?? before} to ${STATE_TEXT[after] ?? after}`;
    })
    .join(", ");
  return `${moved.changed} of ${moved.hours} hours change state: ${transitions}.`;
}

export function RuleChanges({ reg, entry, data }: { reg: string; entry: LabelChangesEntry; data: ChangesData }) {
  const shippedDate = formatAccepted(entry.shipped.accepted);
  const previousDate = entry.previous.accepted ? formatAccepted(entry.previous.accepted) : "earlier";
  if (!entry.compiled || !entry.rules || !entry.hours) {
    return (
      <section className="changes-block" aria-labelledby="rules-heading" data-rule-changes="not-compiled">
        <h2 id="rules-heading" className="display proof-heading">Rules and planner hours</h2>
        <p className="proof-text">
          Labelhand did not compile the {previousDate} label, so there is no rule-by-rule comparison for {entry.shortName}. {entry.why_not_compiled} The
          compiler reads each page&apos;s text layer, and a scan has none; it would have found no rules at all, which would look like every rule was removed.
        </p>
      </section>
    );
  }
  const rules = entry.rules;
  const all = [...rules.added, ...rules.removed, ...rules.changed];
  const labelChanged = sortRuleEntries(all.filter((item) => item.label_changed));
  const compileOnly = sortRuleEntries(all.filter((item) => !item.label_changed));
  const forecasts = Object.entries(entry.hours);
  const tankMoved = forecasts.reduce((sum, [, hours]) => sum + hours.tank.changed, 0);
  const aloneMoved = forecasts.reduce((sum, [, hours]) => sum + hours.alone.changed, 0);
  const forecastHours = forecasts.reduce((sum, [, hours]) => sum + hours.tank.hours, 0);
  const citingNotes = forecasts.flatMap(([name, hours]) =>
    (["tank", "alone"] as const).flatMap((tank) =>
      [
        ...Object.entries(hours[tank].hours_citing_only_previous).map(([key, count]) => ({ name, tank, key, count, date: previousDate })),
        ...Object.entries(hours[tank].hours_citing_only_shipped).map(([key, count]) => ({ name, tank, key, count, date: shippedDate })),
      ],
    ),
  );

  return (
    <section className="changes-block" aria-labelledby="rules-heading" data-rule-changes="compiled">
      <h2 id="rules-heading" className="display proof-heading">Rules and planner hours</h2>
      <p className="proof-text">
        Labelhand compiled the {previousDate} label once, with the pipeline the {shippedDate} label went through, unchanged: Nemotron 3 Super and
        Nemotron 3 Ultra read every page three times on Nebius Token Factory, code checked every quote, and the three readings were merged. That compile
        cost ${entry.compile_cost_usd?.toFixed(2)}. It kept {rules.previous_count} rules against {rules.shipped_count} for the {shippedDate} label.
      </p>

      <div className="proof-tally">
        <div className="proof-tally-item" data-hours-moved={tankMoved + aloneMoved}>
          <span className="display proof-tally-number">{tankMoved} of {forecastHours}</span>
          <span>
            forecast hours change state for the full tank when the earlier label&apos;s rules replace these, over {forecasts.length} committed forecasts.
            For {entry.shortName} alone, {aloneMoved}.
          </span>
        </div>
        <div className="proof-tally-item" data-label-changed={labelChanged.length}>
          <span className="display proof-tally-number">{labelChanged.length}</span>
          <span>rule differences rest on a sentence one PDF&apos;s text layer has and the other&apos;s lacks. Open both pages: a text layer can drop printed words.</span>
        </div>
        <div className="proof-tally-item" data-compile-only={compileOnly.length}>
          <span className="display proof-tally-number">{compileOnly.length}</span>
          <span>rule differences are on sentences both PDFs&apos; text layers have word for word: the two compiles read them differently. {rules.unchanged} rules match exactly.</span>
        </div>
      </div>

      <h3 className="proof-subheading">Planner hours on the committed forecasts</h3>
      <div className="proof-table-wrap changes-table-wrap">
        <table className="proof-table" data-hours-table>
          <caption className="sr-only">Forecast hours that change state when the earlier label replaces this one</caption>
          <thead>
            <tr>
              <th scope="col">Forecast</th>
              <th scope="col">Folex 6 EC, FreeFall SC and Super Boll</th>
              <th scope="col">{entry.shortName} alone</th>
            </tr>
          </thead>
          <tbody>
            {forecasts.map(([name, hours]) => (
              <tr key={name}>
                <th scope="row">
                  {FORECAST_NAMES[name] ?? name}
                  <span className="proof-row-product">NWS forecast fetched {formatForecastTime(data.forecasts[name].forecast_fetched_utc)}</span>
                </th>
                <td><span className="changes-cell-label">Full tank: </span>{hoursText(hours.tank)}</td>
                <td><span className="changes-cell-label">{entry.shortName} alone: </span>{hoursText(hours.alone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {citingNotes.map((note) => (
        <p key={`${note.name}-${note.tank}-${note.key}`} className="changes-note" data-citing-note>
          {FORECAST_NAMES[note.name] ?? note.name}, {note.tank === "tank" ? "full tank" : `${entry.shortName} alone`}: {note.count} hours also cite a clause
          only the {note.date} compile acts on: &quot;{quoteForKey(entry, note.key) ?? note.key}&quot; Other clauses block or flag those hours either way, so
          no state changes.
        </p>
      ))}

      <h3 className="proof-subheading">Sentences in only one PDF&apos;s text</h3>
      {labelChanged.length ? (
        <p className="proof-text">
          Each rule below quotes a sentence that one PDF&apos;s text layer has and the other&apos;s does not. That is usually a change on the label, but a
          text layer can drop words that are printed on the page, so open both pages before relying on one of these.
        </p>
      ) : null}
      {labelChanged.length ? (
        <ul className="proof-diffs" data-label-changed-rules>
          {labelChanged.map((item) => <RuleCard key={`${item.key}-${(item.shipped ?? item.previous)?.param}`} reg={reg} entry={entry} item={item} />)}
        </ul>
      ) : (
        <p className="proof-text" data-no-label-changed-rules>
          None. Every rule difference between the two compiles is on a sentence both PDFs&apos; text layers have word for word.
        </p>
      )}

      <details className="proof-all" data-compile-differences>
        <summary>Same sentence, read differently by the two compiles ({compileOnly.length})</summary>
        <p className="proof-text changes-details-lede">
          Each compile reads every page three times and keeps every rule a reading found, so two compiles of the same text differ. These are those
          differences, rules the planner acts on first. None of them comes from a change in the text.
        </p>
        <ul className="proof-diffs changes-other">
          {compileOnly.map((item) => <RuleCard key={`${item.key}-${(item.shipped ?? item.previous)?.param}`} reg={reg} entry={entry} item={item} />)}
        </ul>
      </details>
    </section>
  );
}

const PLANNER_TEXT = { acting: "The planner acts on this rule.", advisory: "The planner reports this rule as advice.", "not read": "The planner does not read this rule." };

function RuleCard({ reg, entry, item }: { reg: string; entry: LabelChangesEntry; item: RuleEntry }) {
  const kind = item.shipped && item.previous ? "Changed" : item.shipped ? "Added" : "Removed";
  const quote = (item.shipped ?? item.previous) as RuleView;
  return (
    <li className="proof-diff" data-rule-entry={kind.toLowerCase()}>
      <div className="proof-diff-head">
        <Chip tone={kind === "Added" ? "field" : kind === "Removed" ? "red" : "sun"}>{kind}</Chip>
        <span>{quote.param}</span>
        {item.fields ? <span className="proof-row-product">differs in {item.fields.join(", ")}</span> : null}
      </div>
      <blockquote className="proof-quote">{quote.quote}</blockquote>
      <dl className="proof-compare">
        <div>
          <dt>{formatAccepted(entry.previous.accepted ?? "")} label</dt>
          <dd>{item.previous ? `${ruleText(item.previous)}, page ${item.previous.page}. ${PLANNER_TEXT[item.previous.planner]}` : "No rule from this sentence."}</dd>
        </div>
        <div>
          <dt>{formatAccepted(entry.shipped.accepted)} label</dt>
          <dd>{item.shipped ? `${ruleText(item.shipped)}, page ${item.shipped.page}. ${PLANNER_TEXT[item.shipped.planner]}` : "No rule from this sentence."}</dd>
        </div>
      </dl>
      <div className="changes-buttons">
        {item.previous && entry.previous.url && entry.previous.sha256 && entry.previous.accepted ? (
          <ShowOnLabel
            label={`Show on the ${formatAccepted(entry.previous.accepted)} label, page ${item.previous.page}`}
            source={{
              reg,
              product: entry.shortName,
              accepted: entry.previous.accepted,
              url: entry.previous.url,
              page: item.previous.page,
              quote: item.previous.quote,
              version: { file: fileNameOf(entry.previous.url), sha256: entry.previous.sha256 },
            }}
          />
        ) : null}
        {item.shipped ? (
          <ShowOnLabel
            label={`Show on the ${formatAccepted(entry.shipped.accepted)} label, page ${item.shipped.page}`}
            source={{
              reg,
              product: entry.shortName,
              accepted: entry.shipped.accepted,
              url: entry.shipped.url,
              page: item.shipped.page,
              quote: item.shipped.quote,
              version: { file: fileNameOf(entry.shipped.url), sha256: entry.shipped.sha256 },
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
