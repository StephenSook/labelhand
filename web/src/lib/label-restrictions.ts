import type { LabelRecord } from "./planner-data";

type Classification = { sha256: string; restrictedUse: boolean };

// pypdf text extraction checked every page of these accepted PDFs on 2026-10-05.
// None contained the phrase "RESTRICTED USE PESTICIDE".
const CLASSIFICATIONS: Record<string, Classification> = {
  "5481-504": { sha256: "184a62d6439c0aa76356fc8d0edad2bd23825de0e6865c7bc5663993e6f0fe2a", restrictedUse: false },
  "264-700": { sha256: "a54368ee21fda49047de78578937c093c573c472848a46d2342510117f9b403e", restrictedUse: false },
  "264-418": { sha256: "0416a94124e908f51623869612cb1f180a850488de04773fb86f3e1b63372770", restrictedUse: false },
};

export function isRestrictedUseLabel(label: LabelRecord): boolean {
  const classification = CLASSIFICATIONS[label.reg];
  if (!classification || classification.sha256 !== label.sha256) {
    throw new Error(`Restricted-use classification has not been checked for EPA Reg. ${label.reg} at SHA-256 ${label.sha256}.`);
  }
  return classification.restrictedUse;
}
