import type { LabelRecord } from "./planner-data";

type Classification = { sha256: string; restrictedUse: boolean };

// pypdf text extraction checked every page of these accepted PDFs (Folex 6 EC on 2026-10-05, FreeFall SC and
// Super Boll on 2026-10-20). None contained the phrase "RESTRICTED USE PESTICIDE", with or without spaces.
const CLASSIFICATIONS: Record<string, Classification> = {
  "5481-504": { sha256: "184a62d6439c0aa76356fc8d0edad2bd23825de0e6865c7bc5663993e6f0fe2a", restrictedUse: false },
  "228-653": { sha256: "28f688690b11f21b1d2d30517ef95b52b148d74bf6a50b292a63388f86b747c2", restrictedUse: false },
  "228-659": { sha256: "52aca62bf5e83141ea410c2cf13ca4140e3bc8d5f7bbb93d93de839f0cc673bb", restrictedUse: false },
};

export function isRestrictedUseLabel(label: LabelRecord): boolean {
  // A live label carries the result of the same phrase check, run on its own page text by the compiler.
  if (label.unscored && typeof label.restrictedUse === "boolean") return label.restrictedUse;
  const classification = CLASSIFICATIONS[label.reg];
  if (!classification || classification.sha256 !== label.sha256) {
    throw new Error(`Restricted-use classification has not been checked for EPA Reg. ${label.reg} at SHA-256 ${label.sha256}.`);
  }
  return classification.restrictedUse;
}
