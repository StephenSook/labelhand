"use client";

import { useEffect, useMemo, useState } from "react";

import type { ChangeSide, TextChange } from "@/lib/label-diff";
import {
  conditionChanges,
  defaultPair,
  formatAccepted,
  listText,
  orderedPair,
  parseVersionDiff,
  parseVersionList,
  type VersionDiff,
  type VersionList,
  type VersionRow,
} from "@/lib/label-changes";
import { Chip } from "@/ui/Chip";
import { ShowOnLabel } from "@/ui/ShowOnLabel";

type Load<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "error"; message: string };

const PPLS_FILE = /^\d{6}-\d{5}-\d{8}\.pdf$/;

function acceptedOf(fileName: string): string {
  const date = fileName.slice(13, 21);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
}

function setQuery(pair: { from: string; to: string }) {
  const url = new URL(window.location.href);
  url.searchParams.set("from", pair.from);
  url.searchParams.set("to", pair.to);
  window.history.replaceState(window.history.state, "", url);
}

export function LabelVersions({
  reg,
  title,
  shippedFile,
  committedPair,
  initialFrom,
  initialTo,
}: {
  reg: string;
  title: string;
  // The file of the label Labelhand plans with, for the three shipped labels.
  shippedFile?: string;
  // The pair Labelhand compiled, known without asking PPLS, so the text comparison still runs when PPLS is down.
  committedPair?: { from: string; to: string };
  initialFrom?: string;
  initialTo?: string;
}) {
  const [list, setList] = useState<Load<VersionList>>({ kind: "loading" });
  const [pair, setPair] = useState<{ from: string; to: string } | null>(null);
  // Each result is kept with the pair it answers, so a newer pick shows as loading until its own answer arrives.
  const [answer, setAnswer] = useState<{ key: string; load: Load<VersionDiff> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const requested = initialFrom && initialTo && PPLS_FILE.test(initialFrom) && PPLS_FILE.test(initialTo) ? { from: initialFrom, to: initialTo } : null;
    fetch(`/api/labels/versions/${encodeURIComponent(reg)}`)
      .then(async (response) => parseVersionList(response.status, await response.json().catch(() => null)))
      .then((value) => {
        if (cancelled) return;
        setList({ kind: "ready", value });
        const chosen = requested ? orderedPair(value.versions, requested.from, requested.to) : null;
        setPair(chosen ?? defaultPair(value.versions, shippedFile));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setList({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        // The accepted PDFs are served by EPA's file server, not PPLS, so the pair Labelhand knows is still compared.
        setPair(requested ?? committedPair ?? null);
      });
    return () => { cancelled = true; };
  }, [reg, shippedFile, committedPair, initialFrom, initialTo]);

  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    const key = `${pair.from}|${pair.to}`;
    const query = new URLSearchParams({ reg, from: pair.from, to: pair.to });
    fetch(`/api/labels/diff?${query}`)
      .then(async (response) => parseVersionDiff(response.status, await response.json().catch(() => null)))
      .then((value) => { if (!cancelled) setAnswer({ key, load: { kind: "ready", value } }); })
      .catch((error: unknown) => {
        if (!cancelled) setAnswer({ key, load: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
      });
    return () => { cancelled = true; };
  }, [reg, pair]);

  const diff: Load<VersionDiff> | null = !pair ? null : answer?.key === `${pair.from}|${pair.to}` ? answer.load : { kind: "loading" };

  const versions = list.kind === "ready" ? list.value.versions : [];
  const shippedAccepted = shippedFile ? acceptedOf(shippedFile) : undefined;

  function choose(which: "from" | "to", fileName: string) {
    if (!pair) return;
    const next = orderedPair(versions, which === "from" ? fileName : pair.from, which === "to" ? fileName : pair.to);
    if (!next) return;
    setPair(next);
    setQuery(next);
  }

  return (
    <>
      <section className="changes-block" aria-labelledby="versions-heading" data-versions>
        <h2 id="versions-heading" className="display proof-heading">Accepted versions</h2>
        {list.kind === "loading" ? <p className="proof-text" role="status">Reading the list of accepted labels from EPA PPLS...</p> : null}
        {list.kind === "error" ? (
          <p className="changes-alert" role="alert" data-ppls-error>
            {list.message}
          </p>
        ) : null}
        {list.kind === "ready" ? (
          <>
            <p className="proof-text">
              EPA PPLS lists {versions.length} accepted {versions.length === 1 ? "label" : "labels"} for {title}, EPA Reg. {reg}.
              {list.value.stale ? ` PPLS did not answer just now, so this is the list read at ${new Date(list.value.fetchedAt).toUTCString()}.` : ""}
            </p>
            <ol className="changes-versions">
              {versions.map((row) => (
                <li key={row.fileName} data-version={row.fileName} className={pair && (row.fileName === pair.from || row.fileName === pair.to) ? "changes-version-picked" : undefined}>
                  <span className="changes-version-date">{formatAccepted(row.accepted)}</span>
                  <a className="text-link" href={row.url} target="_blank" rel="noreferrer">{row.fileName}</a>
                  {row.fileName === shippedFile ? <Chip tone="field">Labelhand plans with this one</Chip> : null}
                  {shippedAccepted && row.accepted > shippedAccepted ? <Chip tone="red">Newer than the label Labelhand plans with</Chip> : null}
                </li>
              ))}
            </ol>
            {versions.length < 2 ? (
              <p className="proof-text" data-single-version>EPA PPLS lists only one accepted label for this registration, so there is no earlier version to compare.</p>
            ) : null}
            {pair && versions.length >= 2 ? (
              <div className="changes-pickers">
                <label>
                  <span>Earlier label</span>
                  <select value={pair.from} onChange={(event) => choose("from", event.target.value)} data-pick="from">
                    {versions.map((row) => <option key={row.fileName} value={row.fileName}>{formatAccepted(row.accepted)}</option>)}
                  </select>
                </label>
                <label>
                  <span>Later label</span>
                  <select value={pair.to} onChange={(event) => choose("to", event.target.value)} data-pick="to">
                    {versions.map((row) => <option key={row.fileName} value={row.fileName}>{formatAccepted(row.accepted)}</option>)}
                  </select>
                </label>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="changes-block" aria-labelledby="text-heading" data-text-changes>
        <h2 id="text-heading" className="display proof-heading">What the text says now</h2>
        {!pair && list.kind !== "loading" ? (
          <p className="proof-text">No two versions to compare.</p>
        ) : null}
        {pair ? (
          <p className="proof-text">
            The {formatAccepted(acceptedOf(pair.from))} label against the {formatAccepted(acceptedOf(pair.to))} label, compared sentence by sentence from the
            text layer of each PDF. No model reads anything here. Changes that mention wind, rain, temperature, inversions, buffers, droplet size, release
            or boom height, or re-entry come first.
          </p>
        ) : null}
        {diff?.kind === "loading" ? <p className="proof-text" role="status">Reading both PDFs from EPA and comparing them...</p> : null}
        {diff?.kind === "error" ? <p className="changes-alert" role="alert" data-diff-error>{diff.message}</p> : null}
        {diff?.kind === "ready" ? <DiffResult reg={reg} title={title} result={diff.value} /> : null}
      </section>
    </>
  );
}

function DiffResult({ reg, title, result }: { reg: string; title: string; result: VersionDiff }) {
  const { diff, from, to } = result;
  const { spray, other } = useMemo(() => conditionChanges(diff.changes), [diff.changes]);
  const fromDate = formatAccepted(from.accepted);
  const toDate = formatAccepted(to.accepted);
  const scan = diff.unreadable === "from" ? { date: fromDate, pages: from.pages } : diff.unreadable === "to" ? { date: toDate, pages: to.pages } : null;
  if (scan) {
    return (
      <p className="changes-alert" role="status" data-scan>
        The {scan.date} PDF has no text layer on any of its {scan.pages} pages: it is a scan. Its text cannot be compared without reading the images, which
        this page does not do. Pick another version to compare.
      </p>
    );
  }
  if (diff.tooLong) {
    return (
      <p className="changes-alert" role="status" data-too-long>
        These two labels are too long and too different to compare sentence by sentence here ({diff.sentences.from} and {diff.sentences.to} sentences),
        so no change is listed. Pick two versions closer in date.
      </p>
    );
  }
  const blankNote = (pages: number[], date: string) =>
    pages.length ? `Page${pages.length === 1 ? "" : "s"} ${listText(pages)} of the ${date} PDF ${pages.length === 1 ? "has" : "have"} no text layer, so anything printed only there shows up as ${date === fromDate ? "added" : "removed"}.` : "";
  const notes = [blankNote(diff.blankPages.from, fromDate), blankNote(diff.blankPages.to, toDate)].filter(Boolean);
  const card = (change: TextChange, index: number) => (
    <ChangeCard key={`${change.kind}-${index}`} reg={reg} title={title} change={change} from={from} to={to} />
  );
  return (
    <>
      <p className="proof-text" data-diff-summary>
        {diff.changes.length === 0 ? "No sentence changed. " : `${diff.changes.length} ${diff.changes.length === 1 ? "change" : "changes"}, ${spray.length} of them in a sentence that mentions a spray condition. `}
        {diff.formatting} {diff.formatting === 1 ? "block differs" : "blocks differ"} only in spacing, line breaks or punctuation and {diff.moved}{" "}
        {diff.moved === 1 ? "sentence moved" : "sentences moved"} unchanged, so {diff.formatting + diff.moved === 1 ? "it is" : "they are"} not listed.
      </p>
      {notes.map((note) => <p key={note} className="changes-note" data-blank-pages>{note}</p>)}
      <p className="changes-note">
        This compares text layers. Where a PDF&apos;s text layer is missing words printed on the page, they show as changed; open the page to check.
      </p>
      <h3 className="proof-subheading">Spray conditions</h3>
      {spray.length ? (
        <ul className="proof-diffs" data-spray-changes>{spray.map(card)}</ul>
      ) : (
        <p className="proof-text" data-no-spray-changes>No changed sentence mentions a spray condition.</p>
      )}
      {other.length ? (
        <details className="proof-all" data-other-changes>
          <summary>Every other change ({other.length})</summary>
          <ul className="proof-diffs changes-other">{other.map(card)}</ul>
        </details>
      ) : null}
    </>
  );
}

const KIND_TEXT = { added: "Added", removed: "Removed", changed: "Changed" } as const;

function ChangeCard({ reg, title, change, from, to }: {
  reg: string;
  title: string;
  change: TextChange;
  from: VersionDiff["from"];
  to: VersionDiff["to"];
}) {
  return (
    <li className="proof-diff" data-change={change.kind}>
      <div className="proof-diff-head">
        <Chip tone={change.kind === "added" ? "field" : change.kind === "removed" ? "red" : "sun"}>{KIND_TEXT[change.kind]}</Chip>
        {change.conditions.map((condition) => <Chip key={condition} tone="sky">{condition}</Chip>)}
      </div>
      <div className="changes-sides">
        {change.before ? <Side reg={reg} title={title} side={change.before} version={from} when="Before" /> : null}
        {change.after ? <Side reg={reg} title={title} side={change.after} version={to} when="Now" /> : null}
      </div>
    </li>
  );
}

function Side({ reg, title, side, version, when }: {
  reg: string;
  title: string;
  side: ChangeSide;
  version: VersionRow & { sha256: string };
  when: "Before" | "Now";
}) {
  const date = formatAccepted(version.accepted);
  const focus = side.parts.find((part) => part.marked) ?? side.parts[0];
  const pieces: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const [start, end] of side.marks) {
    if (start > at) pieces.push({ text: side.text.slice(at, start), marked: false });
    pieces.push({ text: side.text.slice(start, end), marked: true });
    at = end;
  }
  if (at < side.text.length) pieces.push({ text: side.text.slice(at), marked: false });
  return (
    <div className="changes-side" data-side={when === "Before" ? "before" : "after"}>
      <p className="changes-side-head">
        {when}: {date} label, page{side.pages.length > 1 ? "s" : ""} {listText(side.pages)}
      </p>
      <blockquote className="proof-quote changes-quote">
        {pieces.map((piece, index) => (piece.marked ? <mark key={index}>{piece.text}</mark> : <span key={index}>{piece.text}</span>))}
      </blockquote>
      <ShowOnLabel
        className="mt-3"
        label={`Show on the ${date} label, page ${focus.page}`}
        source={{
          reg,
          product: title,
          accepted: version.accepted,
          url: version.url,
          page: focus.page,
          quote: focus.text,
          version: { file: version.fileName, sha256: version.sha256 },
        }}
      />
    </div>
  );
}
