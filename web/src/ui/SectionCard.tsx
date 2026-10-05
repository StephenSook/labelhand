import type { HTMLAttributes, ReactNode } from "react";

type Props = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  tone?: "paper" | "field" | "sky" | "sun" | "soil" | "ink";
};

export function SectionCard({ children, className = "", tone = "paper", ...props }: Props) {
  return (
    <section className={`section-card section-${tone} ${className}`} {...props}>
      {children}
    </section>
  );
}
