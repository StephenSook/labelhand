import Link from "next/link";
import { Chip } from "./Chip";

export function ShowOnSource({
  href,
  kind,
  page,
  product,
  quote,
  why,
}: {
  href: string;
  kind: "block" | "check" | "advisory";
  page: number;
  product: string;
  quote: string;
  why: string;
}) {
  const label = kind === "block" ? "BLOCKS THIS HOUR" : kind === "check" ? "FIELD CHECK" : "ADVISORY";
  const tone = kind === "block" ? "red" : kind === "check" ? "sun" : "sky";
  return (
    <article className={`source-card source-${kind}`}>
      <div className="source-heading">
        <Chip icon={kind === "block" ? "×" : kind === "check" ? "☀" : "i"} tone={tone}>
          {label}
        </Chip>
        <p>
          <strong>{product}</strong> · page {page}
        </p>
      </div>
      <blockquote>{quote}</blockquote>
      <p className="source-why">{why}</p>
      <Link className="text-link" href={href} rel="noreferrer" target="_blank">
        Open the EPA label, page {page} <span aria-hidden="true">↗</span>
      </Link>
      {kind === "advisory" ? <p className="source-note">This advisory does not change the hour.</p> : null}
    </article>
  );
}
