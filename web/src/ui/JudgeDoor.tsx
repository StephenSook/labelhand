import Link from "next/link";
import type { ReactNode } from "react";

export type JudgeStep = {
  title: string;
  body: ReactNode;
  href?: string;
  action?: string;
};

export function JudgeDoor({ steps }: { steps: JudgeStep[] }) {
  return (
    <ol className="judge-steps">
      {steps.map((step, index) => (
        <li className="judge-step" key={step.title}>
          <span aria-hidden="true" className="judge-number display">
            {index + 1}
          </span>
          <div>
            <h2 className="display">{step.title}</h2>
            <div className="judge-copy">{step.body}</div>
            {step.href ? (
              <Link className="text-link" href={step.href}>
                {step.action ?? "Open this step"} <span aria-hidden="true">→</span>
              </Link>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
