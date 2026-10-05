"use client";

import { useEffect, useMemo, useState } from "react";

export type WorkingStep = {
  label: string;
  detail?: string;
  status?: "pending" | "active" | "waiting" | "working" | "done" | "error";
};

export function WorkingCard({
  currentStep,
  detail,
  startedAt,
  steps,
  title = "Checking this tank",
}: {
  currentStep?: number | string;
  detail?: string;
  startedAt: number;
  steps: WorkingStep[];
  title?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  const activeIndex = typeof currentStep === "number" ? currentStep : steps.findIndex((step) => step.label === currentStep);
  const resolvedSteps = useMemo(
    () =>
      steps.map((step, index) => ({
        ...step,
        status:
          step.status === "active"
            ? "working"
            : step.status === "pending"
              ? "waiting"
              : step.status ?? (activeIndex < 0 ? "waiting" : index < activeIndex ? "done" : index === activeIndex ? "working" : "waiting"),
      })),
    [activeIndex, steps],
  );
  const announcement = useMemo(() => {
    const active = resolvedSteps.find((step) => step.status === "working");
    return active ? `${title}. ${active.label}.` : title;
  }, [resolvedSteps, title]);

  return (
    <section aria-busy="true" aria-labelledby="working-title" className="working-card">
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      <div aria-hidden="true" className="working-weather">
        <span className="working-sun">☀</span>
        <span className="working-line" />
      </div>
      <div>
        <div className="working-heading">
          <h2 className="display" id="working-title">
            {title}
          </h2>
          <output aria-label={`${elapsed} milliseconds elapsed`} className="elapsed-time">
            {elapsed.toLocaleString("en-US")} ms
          </output>
        </div>
        {detail ? <p className="working-detail">{detail}</p> : null}
        <ol className="working-steps">
          {resolvedSteps.map((step) => (
            <li className={`working-step working-${step.status}`} key={step.label}>
              <span aria-hidden="true" className="step-icon">
                {step.status === "done" ? "✓" : step.status === "error" ? "!" : step.status === "working" ? "→" : "·"}
              </span>
              <span>
                <strong>{step.label}</strong>
                {step.detail ? <small>{step.detail}</small> : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
