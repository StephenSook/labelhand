export function Mark({ size = 44, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 72 64"
      width={size * 1.125}
    >
      <path
        d="M13 8h38l10 10v34H13z"
        fill="var(--paper)"
        stroke="var(--ink)"
        strokeLinejoin="round"
        strokeWidth="3.5"
      />
      <path d="M51 8v10h10" fill="var(--sky)" stroke="var(--ink)" strokeLinejoin="round" strokeWidth="3.5" />
      <path
        d="m23 31 7 7 14-16"
        fill="none"
        stroke="var(--field)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
      <path d="M4 49c16-7 39-7 64 1" fill="none" stroke="var(--soil)" strokeLinecap="round" strokeWidth="4" />
      <circle cx="7" cy="48" fill="var(--sun)" r="3" stroke="var(--ink)" strokeWidth="2" />
      <circle cx="65" cy="50" fill="var(--sun)" r="3" stroke="var(--ink)" strokeWidth="2" />
    </svg>
  );
}
