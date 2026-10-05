"use client";

import { useEffect, useId, useRef, useState } from "react";
import { matchingTextItemIndexes } from "@/lib/label-text-match";

export type LabelSource = {
  reg: string;
  product: string;
  accepted: string;
  url: string;
  page: number;
  quote: string;
  quoteCheck?: string;
};

type LoadState =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; highlighted: boolean }
  | { kind: "error"; message: string };

export function ShowOnLabel({ source, className = "" }: {
  source: LabelSource;
  className?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });

  function closeDialog() {
    dialogRef.current?.close();
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function renderPage() {
      const response = await fetch(`/api/label-pdf/${encodeURIComponent(source.reg)}`);
      if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(message || `The label PDF route returned HTTP ${response.status}.`);
      }

      const data = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const loadingTask = pdfjs.getDocument({ data });
      const pdf = await loadingTask.promise;
      if (source.page < 1 || source.page > pdf.numPages) {
        throw new Error(`The label has ${pdf.numPages} pages, so page ${source.page} cannot be shown.`);
      }

      const page = await pdf.getPage(source.page);
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = canvasRef.current;
      const pageElement = pageRef.current;
      const textLayerElement = textLayerRef.current;
      if (!canvas || !pageElement || !textLayerElement || cancelled) return;

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageElement.style.width = `${viewport.width}px`;
      pageElement.style.height = `${viewport.height}px`;
      textLayerElement.replaceChildren();

      const renderTask = page.render({ canvas, viewport });
      const textContent = await page.getTextContent();
      const textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: textLayerElement,
        viewport,
      });
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (cancelled) return;

      let highlighted = false;
      if (!source.quoteCheck) {
        const indexes = matchingTextItemIndexes(
          textLayer.textContentItemsStr.map((str) => ({ str })),
          source.quote,
        );
        for (const index of indexes) {
          const span = textLayer.textDivs[index];
          if (!span) continue;
          span.dataset.labelHighlight = "true";
          span.style.background = "rgba(255, 197, 61, 0.72)";
          span.style.boxShadow = "0 0 0 2px rgba(255, 197, 61, 0.72)";
          highlighted = true;
        }
        textLayer.textDivs[indexes[0]]?.scrollIntoView({ block: "center", inline: "center" });
      }
      setLoadState({ kind: "ready", highlighted });
    }

    void renderPage().catch((error) => {
      if (!cancelled) {
        setLoadState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => { cancelled = true; };
  }, [open, source]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setLoadState({ kind: "loading" });
          setOpen(true);
        }}
        className={`inline-flex min-h-11 items-center rounded-full border-2 border-[#14213d] bg-[#ffc53d] px-4 py-2 text-sm font-extrabold underline decoration-2 underline-offset-4 outline-offset-2 hover:bg-[#ffd873] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d] ${className}`}
      >
        Show on the label, page {source.page}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => { event.preventDefault(); closeDialog(); }}
        onClose={() => {
          setOpen(false);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        className="m-auto max-h-[92vh] w-[min(96vw,76rem)] rounded-[2rem] border-[3px] border-[#14213d] bg-[#fbf7ee] p-0 text-[#14213d] shadow-[8px_10px_0_#14213d] backdrop:bg-[#14213d]/65"
      >
        <div className="flex max-h-[92vh] flex-col">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b-[3px] border-[#14213d] bg-[#9fd3f2] p-4 sm:p-6">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.12em]">Accepted EPA label</p>
              <h2 id={titleId} className="display mt-1 text-3xl sm:text-4xl">{source.product}, page {source.page}</h2>
              <p id={descriptionId} className="mt-2 text-sm font-bold">Accepted {source.accepted}. EPA Reg. {source.reg}.</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={closeDialog}
              className="min-h-11 rounded-full border-2 border-[#14213d] bg-white px-4 py-2 font-black outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#216a38]"
            >
              Close
            </button>
          </header>

          <div data-lenis-prevent className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
            {source.quoteCheck ? (
              <p className="mb-4 rounded-2xl border-2 border-[#8a5a2b] bg-[#ffc53d]/25 p-4 font-bold" role="status">
                This page is a scan. Its text layer is unreadable, so the quote was confirmed by a second reading with NVIDIA Nemotron Parse.
              </p>
            ) : null}
            {loadState.kind === "loading" ? <p className="font-bold" role="status">Loading the verified EPA PDF...</p> : null}
            {loadState.kind === "error" ? (
              <p className="rounded-2xl border-2 border-[#d1433f] bg-[#d1433f]/10 p-4 font-bold text-[#9f2926]" role="alert">
                {loadState.message}
              </p>
            ) : null}
            {loadState.kind === "ready" && !source.quoteCheck && !loadState.highlighted ? (
              <p className="mb-4 rounded-2xl border-2 border-[#8a5a2b] bg-[#ffc53d]/25 p-4 font-bold" role="status">
                The exact sentence was not found in this page&apos;s text layer.
              </p>
            ) : null}

            <div
              ref={pageRef}
              data-label-page
              className={`relative mx-auto bg-white shadow-lg ${loadState.kind === "ready" ? "block" : "hidden"}`}
            >
              <canvas ref={canvasRef} aria-label={`EPA label page ${source.page}`} className="block" />
              <div
                ref={textLayerRef}
                aria-hidden="true"
                className="absolute inset-0 overflow-hidden leading-none opacity-100 [&>br]:absolute [&>span]:absolute [&>span]:m-0 [&>span]:origin-top-left [&>span]:whitespace-pre [&>span]:text-transparent"
              />
            </div>
          </div>

          <footer className="border-t-[3px] border-[#14213d] bg-white p-4 sm:px-6">
            <a
              href={`${source.url}#page=${encodeURIComponent(String(source.page))}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center rounded-full border-2 border-[#14213d] bg-white px-4 py-2 text-sm font-extrabold underline decoration-2 underline-offset-4 outline-offset-2 hover:bg-[#9fd3f2]/35 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d]"
            >
              Open the EPA PDF
            </a>
          </footer>
        </div>
      </dialog>
    </>
  );
}
