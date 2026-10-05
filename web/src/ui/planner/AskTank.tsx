"use client";

import { useState } from "react";
import { runAgentLoop, type AgentRunResult, type AgentTraceEntry } from "@/lib/agent/loop";
import type { AgentCheckSnapshot } from "@/lib/agent/tools";
import { WorkingCard, type WorkingStep } from "@/ui";

const EXAMPLES = [
  "When can I spray all three at Tift this week for a 4-hour job?",
  "Why is the next blocked hour at Worth blocked?",
  "Which label sets the strictest wind limit in this tank?",
] as const;

type AskTankProps = {
  onCheck: (snapshot: AgentCheckSnapshot) => void;
  onClause: (ruleId: string) => void;
  onWindow: (index: number) => void;
};

function stepIndex(status: string): number {
  if (status.startsWith("Calling Nemotron")) return 0;
  if (status.startsWith("Running final_answer")) return 2;
  return 1;
}

function workingSteps(status: string): WorkingStep[] {
  const current = stepIndex(status);
  return ["Call NVIDIA Nemotron", "Run planner tools", "Check the answer"].map((label, index) => ({
    label,
    detail: index === current ? status : index < current ? "Finished" : "Waiting",
    status: index < current ? "done" : index === current ? "active" : "waiting",
  }));
}

function TraceRow({ entry }: { entry: AgentTraceEntry }) {
  if (entry.type === "model") {
    return (
      <li
        data-model-call
        data-model={entry.model}
        data-tokens-in={entry.tokensIn}
        data-tokens-out={entry.tokensOut}
        className="rounded-2xl border-2 border-[#14213d] bg-white p-3"
      >
        <strong>Model: {entry.model}</strong>
        <p>{entry.latencyMs.toLocaleString("en-US")} ms · {entry.tokensIn.toLocaleString("en-US")} in · {entry.tokensOut.toLocaleString("en-US")} out · ${entry.costUsd.toFixed(6)}</p>
        {entry.requestId ? <p className="break-all text-xs">Request ID: {entry.requestId}</p> : null}
      </li>
    );
  }
  if (entry.type === "tool") {
    return (
      <li data-tool-call={entry.name} className="rounded-2xl border-2 border-[#14213d] bg-white p-3">
        <strong>Tool: {entry.name}</strong>
        <p>{entry.ms.toLocaleString("en-US")} ms · {entry.resultSummary}</p>
        <code className="mt-1 block break-words text-xs">{JSON.stringify(entry.args)}</code>
      </li>
    );
  }
  return (
    <li data-agent-guard={entry.passed ? "passed" : "failed"} className="rounded-2xl border-2 border-[#14213d] bg-white p-3">
      <strong>Guard: {entry.passed ? "passed" : "failed"}</strong>
      {entry.reasons.map((reason) => <p key={reason}>{reason}</p>)}
    </li>
  );
}

export function AskTank({ onCheck, onClause, onWindow }: AskTankProps) {
  const [question, setQuestion] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [status, setStatus] = useState("Calling Nemotron");
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = question.trim();
    if (!trimmed || startedAt !== null) return;
    setError(null);
    setResult(null);
    setStatus("Calling Nemotron");
    setStartedAt(Date.now());
    try {
      const completed = await runAgentLoop(trimmed, setStatus);
      setResult(completed);
      if (completed.latestCheck) onCheck(completed.latestCheck);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartedAt(null);
    }
  }

  return (
    <section id="ask-the-tank" aria-labelledby="ask-tank-heading" className="section-card mx-auto mt-5 max-w-[92rem] bg-[#ffc53d] px-4 py-9 text-[#14213d] sm:px-8 lg:px-12">
      <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr]">
        <div>
          <p className="hand -rotate-2 text-3xl text-[#14213d]">NVIDIA Nemotron · real planner tools</p>
          <h2 id="ask-tank-heading" className="display mt-2 text-5xl sm:text-6xl">Ask the tank.</h2>
          <p className="mt-4 max-w-xl font-bold leading-relaxed">
            Ask in plain language. Nemotron can inspect the same forecast, label clauses, and WebAssembly planner shown on this page. Its answer is checked against its tool results before it appears.
          </p>
        </div>

        <form
          aria-label="Ask the tank"
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
          className="rounded-[2rem] border-[3px] border-[#14213d] bg-[#fbf7ee] p-5 shadow-[7px_9px_0_#14213d] sm:p-7"
        >
          <label htmlFor="tank-question" className="display text-2xl">Question</label>
          <input
            id="tank-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={startedAt !== null}
            placeholder="Ask about a field, window, or label clause"
            className="mt-3 min-h-14 w-full rounded-2xl border-2 border-[#14213d] bg-white px-4 py-3 font-bold outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e]"
          />
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Example questions">
            {EXAMPLES.map((example) => (
              <button
                type="button"
                key={example}
                onClick={() => setQuestion(example)}
                disabled={startedAt !== null}
                className="min-h-11 rounded-full border-2 border-[#14213d] bg-[#9fd3f2]/45 px-3 py-2 text-left text-sm font-extrabold outline-offset-2 hover:bg-[#9fd3f2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#2f8f4e]"
              >
                {example}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={!question.trim() || startedAt !== null}
            className="mt-5 min-h-14 w-full rounded-full border-[3px] border-[#14213d] bg-[#216a38] px-6 text-lg font-black text-white shadow-[4px_5px_0_#14213d] outline-offset-2 transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#14213d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Run Ask the tank
          </button>
        </form>
      </div>

      {startedAt !== null ? (
        <div className="mt-8">
          <WorkingCard
            title="Asking the tank"
            startedAt={startedAt}
            currentStep={stepIndex(status)}
            steps={workingSteps(status)}
            detail={status}
          />
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only" role="status">{startedAt !== null ? status : result ? "Ask the tank finished." : ""}</p>
      {error ? <p role="alert" className="mt-8 rounded-2xl border-[3px] border-[#14213d] bg-[#d1433f]/15 p-4 font-bold">{error}</p> : null}

      {result ? (
        <section data-agent-result aria-labelledby="agent-answer-heading" className="mt-8 rounded-[2rem] border-[3px] border-[#14213d] bg-[#fbf7ee] p-5 shadow-[6px_7px_0_#14213d] sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="agent-answer-heading" className="display text-3xl">Answer</h3>
            <span className={`rounded-full border-2 border-[#14213d] px-3 py-1 text-sm font-black ${result.guard.passed ? "bg-[#216a38] text-white" : "bg-[#d1433f] text-white"}`}>
              Guard {result.guard.passed ? "passed" : "failed"}
            </span>
          </div>
          {result.answer ? <p className="mt-4 text-lg font-bold leading-relaxed">{result.answer.summary}</p> : <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{result.fallbackText}</pre>}

          {result.answer?.cited_rule_ids.length ? (
            <div className="mt-5">
              <p className="text-xs font-extrabold uppercase tracking-[0.12em]">Cited clauses</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {result.answer.cited_rule_ids.map((ruleId) => (
                  <button key={ruleId} type="button" onClick={() => onClause(ruleId)} className="min-h-11 rounded-full border-2 border-[#14213d] bg-white px-4 py-2 font-extrabold underline decoration-2 underline-offset-4">{ruleId}</button>
                ))}
              </div>
            </div>
          ) : null}

          {result.answer?.window_indices.length ? (
            <div className="mt-5">
              <p className="text-xs font-extrabold uppercase tracking-[0.12em]">Forecast-permitted windows</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {result.answer.window_indices.map((index) => (
                  <button key={index} type="button" onClick={() => onWindow(index)} className="min-h-11 rounded-full border-2 border-[#14213d] bg-[#216a38] px-4 py-2 font-extrabold text-white">Window {index}</button>
                ))}
              </div>
            </div>
          ) : null}

          <details data-agent-trace className="mt-7 rounded-2xl border-2 border-[#14213d] bg-[#9fd3f2]/25 p-4">
            <summary className="cursor-pointer font-black">Trace · total cost ${result.totalCostUsd.toFixed(6)}</summary>
            <ol className="mt-4 grid gap-3">
              {result.trace.map((entry, index) => <TraceRow key={`${entry.type}-${index}`} entry={entry} />)}
            </ol>
          </details>
        </section>
      ) : null}
    </section>
  );
}
