import type { ReactNode } from "react";

export function Chip({ children, icon, tone = "ink" }: { children: ReactNode; icon?: ReactNode; tone?: "ink" | "field" | "sun" | "red" | "sky" }) {
  return (
    <span className={`chip chip-${tone}`}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}
