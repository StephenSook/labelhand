"use client";

import { useEffect, useRef, useState } from "react";
import { LiveCompileClientError, requestLiveCompile } from "@/lib/compiler/client";
import type { CompiledLiveLabel, PipelineEvent } from "@/lib/compiler/pipeline";
import { PhotoClientError, readLabelPhotoFromBrowser } from "@/lib/photo-client";
import type { PhotoReadResult } from "@/lib/photo-reading";

export const MAX_LIVE_LABELS = 3;
const FEDERAL_REG = /^\d{1,6}-\d{1,5}$/;

type SearchResult = { reg: string; product: string; alternateBrandNames: string[] };

type Progress = {
  product?: string;
  accepted?: string;
  kilobytes?: number;
  cached?: boolean;
  pages?: number;
  pagesDone: number;
  kept: number;
  rejected: number;
  typing?: { done: number; of: number };
  raised?: number;
};

const EMPTY_PROGRESS: Progress = { pagesDone: 0, kept: 0, rejected: 0 };

function advance(progress: Progress, event: PipelineEvent): Progress {
  switch (event.type) {
    case "listed":
      return { ...progress, product: event.product, accepted: event.accepted };
    case "pdf":
      return { ...progress, kilobytes: Math.round(event.bytes / 1024), accepted: event.accepted };
    case "cached":
      return { ...progress, cached: true };
    case "extracted":
      return { ...progress, pages: event.pages };
    case "page":
      return { ...progress, pages: event.of, pagesDone: progress.pagesDone + 1, kept: progress.kept + event.accepted, rejected: progress.rejected + event.rejected };
    case "typing":
      return { ...progress, typing: { done: event.done, of: event.of } };
    case "floor":
      return { ...progress, raised: event.raised };
    default:
      return progress;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Stopped. Nothing was added to the tank.";
  if (error instanceof LiveCompileClientError || error instanceof PhotoClientError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function AnyLabel({ disabled, liveLabels, onAdd, onRemove, shippedRegs = [], onSelectShipped }: {
  disabled: boolean;
  liveLabels: CompiledLiveLabel[];
  onAdd: (compiled: CompiledLiveLabel) => void;
  onRemove: (reg: string) => void;
  // The scored labels already in the app. Picking one selects its chip instead of an unscored live copy.
  shippedRegs?: readonly string[];
  onSelectShipped?: (reg: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [compiling, setCompiling] = useState<{ reg: string; progress: Progress } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [photo, setPhoto] = useState<{ preview: string; result: PhotoReadResult } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const full = liveLabels.length >= MAX_LIVE_LABELS;
  const busy = disabled || searching || reading || Boolean(compiling);

  // The preview is a local object URL of the visitor's own photo; release it when replaced.
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.preview); }, [photo]);

  async function readPhoto(file: File) {
    setMessage(null);
    setResults(null);
    setPhoto(null);
    setReading(true);
    const preview = URL.createObjectURL(file);
    try {
      const result = await readLabelPhotoFromBrowser(file);
      setPhoto({ preview, result });
    } catch (error) {
      URL.revokeObjectURL(preview);
      setMessage(errorMessage(error));
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function search() {
    const value = query.trim();
    setMessage(null);
    if (FEDERAL_REG.test(value)) {
      setResults([{ reg: value, product: `EPA Reg. No. ${value}`, alternateBrandNames: [] }]);
      return;
    }
    if (value.length < 3) {
      setMessage("Type at least 3 letters of a product name, or an EPA Reg. No. such as 100-1256.");
      return;
    }
    setSearching(true);
    try {
      const response = await fetch(`/api/labels/search?q=${encodeURIComponent(value)}`);
      const body = await response.json() as { results?: SearchResult[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `EPA product search returned HTTP ${response.status}.`);
      const found = body.results ?? [];
      setResults(found);
      if (found.length === 0) setMessage(`EPA lists no active federal product matching "${value}".`);
    } catch (error) {
      setResults(null);
      setMessage(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }

  async function compile(reg: string) {
    if (shippedRegs.includes(reg) && onSelectShipped) {
      onSelectShipped(reg);
      setResults(null);
      setQuery("");
      setMessage(`EPA Reg. No. ${reg} is one of the scored labels, so its chip is now in the tank.`);
      return;
    }
    if (liveLabels.some((label) => label.reg === reg)) {
      setMessage(`EPA Reg. No. ${reg} is already in the tank.`);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setMessage(null);
    let progress = EMPTY_PROGRESS;
    setCompiling({ reg, progress });
    try {
      const compiled = await requestLiveCompile(reg, (event) => {
        progress = advance(progress, event);
        setCompiling({ reg, progress });
      }, fetch, controller.signal);
      onAdd(compiled);
      setResults(null);
      setQuery("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      abort.current = null;
      setCompiling(null);
    }
  }

  return (
    <section aria-labelledby="any-label-heading" className="mt-7 rounded-2xl border-2 border-dashed border-[#14213d] bg-white/70 p-4" data-any-label>
      <h2 id="any-label-heading" className="display text-xl">Add any EPA label</h2>
      <p className="mt-1 text-sm font-semibold text-[#14213d]/75">
        Search EPA&apos;s label system by product name or EPA Reg. No. Nemotron on Nebius Token Factory reads the newest accepted label
        while you wait (17 to 75 seconds in our runs). No gold set has checked these rules, so they are marked UNSCORED.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="any-label-query" className="sr-only">Product name or EPA Reg. No.</label>
        <input
          id="any-label-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!busy && !full) void search();
            }
          }}
          disabled={busy || full}
          placeholder="Product name or 100-1256"
          autoComplete="off"
          className="min-h-12 min-w-0 flex-1 rounded-2xl border-2 border-[#14213d] bg-white px-4 font-bold outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e]"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={busy || full}
          className="min-h-12 rounded-full border-2 border-[#14213d] bg-[#9fd3f2] px-5 font-black outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {searching ? "Searching EPA" : "Search EPA"}
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy || full}
          data-photo-button
          className="min-h-12 rounded-full border-2 border-[#14213d] bg-[#ffc53d] px-5 font-black outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reading ? "Reading the photo" : "Photograph the jug"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-label="Photo of the product label"
          data-photo-input
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readPhoto(file);
          }}
        />
      </div>
      <p className="mt-2 text-xs font-semibold text-[#14213d]/70">
        A photo is read by Nemotron 3.5 Super VL and checked against EPA&apos;s own records before anything is compiled. It is not stored.
      </p>
      {photo && !compiling ? (
        <PhotoResult
          photo={photo}
          disabled={busy || full}
          onRead={(reg) => { setPhoto(null); void compile(reg); }}
        />
      ) : null}
      {full ? <p className="mt-2 text-sm font-bold">The tank holds up to {MAX_LIVE_LABELS} live labels. Remove one to add another.</p> : null}

      {results && results.length > 0 && !compiling ? (
        <ul className="mt-3 grid gap-2" aria-label="EPA products found">
          {results.map((result) => (
            <li key={result.reg}>
              <button
                type="button"
                onClick={() => void compile(result.reg)}
                disabled={busy || full}
                className="flex w-full flex-wrap items-baseline justify-between gap-2 rounded-xl border-2 border-[#14213d] bg-[#fbf7ee] px-3 py-2 text-left font-bold outline-offset-2 hover:bg-white focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{result.product}</span>
                <span className="text-sm">EPA Reg. No. {result.reg}: read this label</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {compiling ? <CompileProgress reg={compiling.reg} progress={compiling.progress} onStop={() => abort.current?.abort()} /> : null}

      {message ? <p role="alert" className="mt-3 rounded-xl border-2 border-[#b53432] bg-[#f8ddda] p-3 text-sm font-bold">{message}</p> : null}

      {liveLabels.length > 0 ? (
        <ul className="mt-4 grid gap-2" aria-label="Live labels in the tank">
          {liveLabels.map((label) => (
            <li key={label.reg} data-live-label={label.reg} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border-2 border-[#14213d] bg-[#216a38] px-3 py-3 text-white">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-black leading-tight">{label.product}</span>
                  <span className="rounded-full border-2 border-white bg-[#ffc53d] px-2 py-0.5 text-xs font-black text-[#14213d]">UNSCORED</span>
                </span>
                <span className="mt-1 block text-xs font-bold">
                  EPA Reg. {label.reg}, accepted {label.label_accepted}. {label.accepted.length} rules kept, {label.rejected.length} rejected by the guards.
                  {label.complete ? "" : " Some pages or second readings failed, so this reading is incomplete."}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onRemove(label.reg)}
                disabled={disabled}
                className="min-h-10 rounded-full border-2 border-white px-3 text-sm font-black outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#ffc53d] disabled:opacity-50"
                aria-label={`Remove ${label.product}, EPA Reg. ${label.reg}, from the tank`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CompileProgress({ reg, progress, onStop }: { reg: string; progress: Progress; onStop: () => void }) {
  const steps: Array<{ label: string; done: boolean }> = [
    { label: progress.product ? `Found on EPA PPLS: ${progress.product}${progress.accepted ? `, accepted ${progress.accepted}` : ""}` : `Looking up EPA Reg. No. ${reg}`, done: Boolean(progress.product) },
  ];
  if (progress.cached) {
    steps.push({ label: "Already read once: loaded the stored result, no model call", done: true });
  } else {
    steps.push({ label: progress.kilobytes ? `Downloaded the label PDF, ${progress.kilobytes.toLocaleString("en-US")} KB` : "Downloading the label PDF", done: Boolean(progress.kilobytes) });
    steps.push({
      label: progress.pages
        ? `Nemotron 3 Super read ${progress.pagesDone} of ${progress.pages} pages: ${progress.kept} rules kept, ${progress.rejected} rejected by the guards`
        : "Extracting the page text",
      done: Boolean(progress.pages) && progress.pagesDone === progress.pages,
    });
    if (progress.typing) {
      steps.push({ label: `Nemotron 3 Ultra typed ${progress.typing.done} of ${progress.typing.of} weather rules`, done: progress.typing.done === progress.typing.of });
    }
    if (progress.raised !== undefined) {
      steps.push({ label: `EPA's mandatory-wording rule raised ${progress.raised} ${progress.raised === 1 ? "rule" : "rules"}`, done: true });
    }
  }
  const fraction = progress.pages ? progress.pagesDone / progress.pages : 0;

  return (
    <div className="mt-3 rounded-2xl border-2 border-[#14213d] bg-[#fbf7ee] p-3" aria-live="polite" data-compile-progress>
      <div className="h-3 overflow-hidden rounded-full border-2 border-[#14213d] bg-white" role="progressbar" aria-label="Pages read" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <div className="h-full bg-[#2f8f4e] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      <ol className="mt-3 grid gap-1 text-sm font-bold">
        {steps.map((step) => (
          <li key={step.label} className={step.done ? "" : "text-[#14213d]/70"}>
            <span aria-hidden="true">{step.done ? "✓ " : "… "}</span>
            {step.label}
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={onStop}
        className="mt-3 min-h-10 rounded-full border-2 border-[#14213d] px-4 text-sm font-black outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e]"
      >
        Stop
      </button>
    </div>
  );
}

function PhotoResult({ photo, disabled, onRead }: {
  photo: { preview: string; result: PhotoReadResult };
  disabled: boolean;
  onRead: (reg: string) => void;
}) {
  const { result } = photo;
  const reg = result.epa_reg_no ?? result.read_epa_reg_no;
  let body: React.ReactNode;
  let action: string | null = null;
  if (result.verdict === "MATCHED" && reg) {
    body = <>Read EPA Reg. No. <strong>{reg}</strong>, {result.epa_product_name}. EPA&apos;s records agree with the name on the jug.</>;
    action = `Read ${result.epa_product_name ?? "this label"}`;
  } else if (result.verdict === "NAME_DIFFERS" && reg) {
    body = <>Read EPA Reg. No. <strong>{reg}</strong>, but EPA lists that number as <strong>{result.epa_product_name}</strong>, while the photo shows {result.model_product_name ?? "a different name"}. Check the jug before you continue.</>;
    action = `It is ${result.epa_product_name ?? reg}, read it`;
  } else if (result.verdict === "NOT_FOUND") {
    body = <>Read EPA Reg. No. <strong>{result.read_epa_reg_no}</strong>, but EPA has no active product with that number. Retake the photo with the &quot;EPA Reg. No.&quot; line sharp and in frame.</>;
  } else {
    body = <>No registration number was legible. What the model saw: {result.what_is_visible || "nothing readable"}. Retake the photo closer to the &quot;EPA Reg. No.&quot; line.</>;
  }
  return (
    <div className="mt-3 grid gap-3 rounded-2xl border-2 border-[#14213d] bg-[#fbf7ee] p-3 sm:grid-cols-[6rem_1fr]" data-photo-result={result.verdict}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL of the visitor's own photo */}
      <img src={photo.preview} alt="The label photo you chose" className="h-24 w-24 rounded-xl border-2 border-[#14213d] object-cover" />
      <div className="min-w-0">
        <p className="text-sm font-bold leading-relaxed">{body}</p>
        <p className="mt-1 text-xs font-semibold text-[#14213d]/65">
          {result.model}, {(result.latency_ms / 1000).toFixed(1)} s
        </p>
        {action && reg ? (
          <button
            type="button"
            onClick={() => onRead(reg)}
            disabled={disabled}
            className="mt-2 min-h-11 rounded-full border-2 border-[#14213d] bg-[#216a38] px-4 text-sm font-black text-white outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#ffc53d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action}
          </button>
        ) : null}
      </div>
    </div>
  );
}
