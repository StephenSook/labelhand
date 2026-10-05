import type { ReactNode } from "react";

export type PlannerState = "FORECAST-PERMITTED" | "BLOCKED" | "FIELD CHECK" | "NO DATA";

const stateIcons: Record<PlannerState, string> = {
  "FORECAST-PERMITTED": "✓",
  BLOCKED: "×",
  "FIELD CHECK": "☀",
  "NO DATA": "?",
};

const stateClasses: Record<PlannerState, string> = {
  "FORECAST-PERMITTED": "state-permitted",
  BLOCKED: "state-blocked",
  "FIELD CHECK": "state-check",
  "NO DATA": "state-no-data",
};

export function Stamp({ children, state }: { children?: ReactNode; state: PlannerState | string }) {
  const knownState = state as PlannerState;
  return (
    <span className={`stamp ${stateClasses[knownState] ?? stateClasses["NO DATA"]}`}>
      <span aria-hidden="true">{stateIcons[knownState] ?? stateIcons["NO DATA"]}</span>
      {children ?? state}
    </span>
  );
}
