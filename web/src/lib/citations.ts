import type { Citation } from "@/lib/planner-data";

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Merged readings can keep two rules for one label sentence, one quoting it alone and one quoting
// it with the sentence after it, and both come back for the same hour under the same rule id. Show
// that clause once, with the longer quote. Two different sentences under one id both stay.
export function collapseRepeatedClauses(citations: Citation[]): Citation[] {
  const shown: Citation[] = [];
  for (const citation of citations) {
    const quote = normalized(citation.quote);
    const index = shown.findIndex((kept) => {
      if (kept.product !== citation.product || kept.rule !== citation.rule || kept.why !== citation.why) return false;
      const keptQuote = normalized(kept.quote);
      return keptQuote.includes(quote) || quote.includes(keptQuote);
    });
    if (index === -1) shown.push(citation);
    else if (citation.quote.length > shown[index]!.quote.length) shown[index] = citation;
  }
  return shown;
}
