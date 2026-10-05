export function ArchitectureDiagram() {
  return (
    <div className="architecture-diagram" aria-label="Labelhand data and model execution path">
      <svg className="architecture-paths" viewBox="0 0 1000 520" aria-hidden="true" preserveAspectRatio="none">
        <defs>
          <marker id="architecture-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <path d="M180 100 C260 100 270 100 340 100" />
        <path d="M180 120 C260 160 270 205 340 220" />
        <path d="M530 100 C610 100 610 150 690 170" />
        <path d="M530 220 C610 220 620 195 690 180" />
        <path d="M830 220 C830 280 720 310 620 345" />
        <path d="M180 385 C300 385 360 385 445 385" />
        <path d="M620 385 C700 385 720 385 790 385" />
      </svg>

      <ArchitectureNode className="architecture-pdf" eyebrow="Source" title="EPA PPLS label PDFs">
        Three accepted pesticide labels, verified by file hash.
      </ArchitectureNode>
      <ArchitectureNode className="architecture-compile" eyebrow="Offline compile" title="Nemotron 3 Super + Ultra">
        Strict-schema extraction and typing on Nebius Token Factory.
      </ArchitectureNode>
      <ArchitectureNode className="architecture-parse" eyebrow="Second reading" title="Nemotron Parse 2.0">
        Page OCR on a Nebius AI Cloud L40S job.
      </ArchitectureNode>
      <ArchitectureNode className="architecture-vote" eyebrow="Deterministic gate" title="EPA modality floor + 3-run vote">
        PR Notice 2000-5 directives set the floor. Two matching run votes win.
      </ArchitectureNode>
      <ArchitectureNode className="architecture-weather" eyebrow="Live input" title="National Weather Service">
        The browser fetches the hourly forecast from api.weather.gov.
      </ArchitectureNode>
      <ArchitectureNode className="architecture-wasm" eyebrow="Browser planner" title="Rust compiled to WebAssembly">
        Shipped rules and forecast periods produce 156 hourly states in the browser.
      </ArchitectureNode>
      <ArchitectureNode className="architecture-agent" eyebrow="Runtime agent" title="Nemotron 3.5 Lightning + guard">
        Token Factory answers from planner tools. A deterministic final-answer guard checks it before display.
      </ArchitectureNode>
    </div>
  );
}

function ArchitectureNode({ className, eyebrow, title, children }: {
  className: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`architecture-node ${className}`}>
      <p>{eyebrow}</p>
      <h3 className="display">{title}</h3>
      <span>{children}</span>
    </article>
  );
}
