# Spike 01: compile real EPA labels into clause-cited rules (2026-10-05)

## What ran
- `tools/ppls_fetch.py` pulled the newest EPA-accepted label PDF for each registration from PPLS, content-checked (PDF magic, size) and hashed:
  - Folex 6 EC, EPA Reg. 5481-504, accepted 2026-03-04, 11 pages
  - Dropp SC, EPA Reg. 264-700, accepted 2009-12-14 (newest PPLS lists), 9 pages, scanned with a poor OCR text layer
  - Prep (ethephon), EPA Reg. 264-418, accepted 2021-02-24, 12 pages
- `compiler/compile_label.py`: one Nemotron 3 Super call per page on Nebius Token Factory with a strict JSON schema (guided decoding), temperature 0, thinking off, 4 pages in parallel. Deterministic guards in code: verbatim quote (whitespace-insensitive), no spliced quotes, every number in the rule present in its quote (fractions and mixed numbers understood).
- Guard self-test passes on planted cases (a real quote passes; a fabricated quote and a fabricated number are both rejected).

## Measured (run 2, after the guard and prompt fixes)
| Label | Accepted | Rejected | Reject reasons | Tokens in/out | Cost | Slowest page |
|---|---|---|---|---|---|---|
| Folex 6 EC | 47 | 6 | 2 too short, 3 number not in quote, 1 quote not in page | 14,668 / 6,287 | $0.0101 | 11.1 s |
| Dropp SC | 20 | 11 | 4 spliced, 2 number, 5 quote (scan garbage) | 12,962 / 3,610 | $0.0071 | 7.2 s |
| Prep | 53 | 1 | 1 number | 14,573 / 6,832 | $0.0105 | 9.5 s |

Three labels, 32 pages, $0.028, about 10 s per label wall-clock.

## What the guards caught (real model errors, not noise)
- Folex re-entry interval: the label sets 7 days at or below 0.75 lb ai/A and 10 days above it. The model spliced the sentence with "..." into one 10-day rule and dropped the rate condition. Rejected (QUOTE_SPLICED). (Corrected 2026-10-05: an earlier version of this note said the label only says 7 days.)
- Unit conversions done by the model (3 feet to 36 inches; one-half mile to 2,640 ft): rejected. Conversion belongs in code.
- Invented numbers on clauses with no number: rejected.

## Problems found
1. **Run-to-run coverage varies at temperature 0.** Folex accepted 67 rules in run 1 and 47 in run 2. Recall must be measured against a gold set, and extraction should union two passes (Super plus Lightning or Ultra) with dedupe.
2. **Parameter labels are sometimes wrong** although the quote is right: "nurse tank" tagged night_temperature_f, a rinse "2 minutes" tagged rain_free_hours, "bottom 1/3 of plant" tagged buffer_ft 1. Fix: a second typing pass (Ultra, or the planned ModernBERT classifier) restricted to planner parameters; the planner acts only on rules whose type both passes agree on; disagreements go to review.
3. **Unmappable glyph:** the 2026 Folex PDF has no Unicode map for the half glyph, so "2 1/2 pints" extracts as "2" followed by U+FFFD in both pypdf and pdfminer. Guard now returns UNREADABLE_GLYPH; next step is a vision read of the rendered page region (Token Factory vision model) whose answer is checked against the text around the gap.
4. **Dropp SC's newest accepted label (2009) is a scan** with a garbage OCR layer. Needs our own OCR (Nemotron Parse 2.0 or docTR locally) before compiling; or the tool must say "label text unreadable, rules from this label are not used."
5. **Duplicates** (the same clause compiled twice on one page). Dedupe on normalized quote.

## Next
1. Gold set: hand-annotate the planner-relevant clauses of all three labels (wind, inversion, rain, temperature, buffers, release height, droplet size, re-entry, open-boll stage) with page and exact quote; then report precision, recall, numeric exact-match and modality accuracy (Q1). The gold set is our own annotation until an outside reviewer checks it, and it is labelled that way.
2. Second-pass typing + union + dedupe; measure the change in Q1.
3. Vision fallback for unreadable glyphs; OCR path for scanned labels.
4. Planner kernel: compiled rules + recorded NWS hourly forecast for a field point gives hourly FORECAST-PERMITTED / BLOCKED (with clause) / NEEDS FIELD CHECK; first in Python against data/nws_recorded, then the Rust core.
