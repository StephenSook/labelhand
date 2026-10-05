"""Merge accepted rules from repeated compiler runs into one shipped rule set.

Rules use the same dedupe key as engine/windows.py: parameter plus the lowercased quote with
every run of non-word characters removed. Modalities are counted once per run. A modality found
in at least two runs wins; a tie keeps the first acting modality, then the first modality.

Run:
    python compiler/merge_runs.py 5481-504 264-700 264-418
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[1]
COMPILED = ROOT / "data" / "compiled"
DEFAULT_RUNS = [
    ".union.p2.typed.v3.ocr.mf",
    ".union.p2r2.typed.v3.ocr.mf",
    ".union.p2r3.typed.v3.ocr.mf",
]
ACTING = {"MUST", "MUST_NOT"}


def rule_key(rule: dict) -> tuple[str, str]:
    """Return the exact clause identity used by engine/windows.py load_rules."""
    return rule["param"], re.sub(r"\W+", "", rule["quote"].lower())


def _preferred_modality(current: str, candidate: str) -> str:
    if current not in ACTING and candidate in ACTING:
        return candidate
    return current


def _winning_modality(modality_by_run: dict[str, str], run_names: list[str]) -> tuple[str, dict[str, int]]:
    counts = Counter(modality_by_run.values())
    majority = next((modality for modality, count in counts.items() if count >= 2), None)
    if majority is not None:
        return majority, dict(sorted(counts.items()))

    for run_name in run_names:
        modality = modality_by_run.get(run_name)
        if modality in ACTING:
            return modality, dict(sorted(counts.items()))
    return next(iter(modality_by_run.values())), dict(sorted(counts.items()))


def merge_reports(reports: list[dict], run_names: list[str]) -> dict:
    if not reports or len(reports) != len(run_names):
        raise ValueError("reports and run_names must be non-empty and have the same length")

    product = reports[0].get("product")
    reg = reports[0].get("reg")
    if any(report.get("product") != product or report.get("reg") != reg for report in reports[1:]):
        raise ValueError("all merged reports must describe the same product and registration")

    candidates: dict[tuple[str, str], dict[str, dict]] = {}
    for report, run_name in zip(reports, run_names, strict=True):
        for rule in report["accepted"]:
            key = rule_key(rule)
            by_run = candidates.setdefault(key, {})
            current = by_run.get(run_name)
            if current is None or _preferred_modality(current["modality"], rule["modality"]) != current["modality"]:
                by_run[run_name] = rule

    kept = []
    for by_run in candidates.values():
        modality_by_run = {run_name: by_run[run_name]["modality"] for run_name in run_names if run_name in by_run}
        winner, vote = _winning_modality(modality_by_run, run_names)
        selected = next(by_run[run_name] for run_name in run_names if run_name in by_run and by_run[run_name]["modality"] == winner)
        kept.append(
            {
                **selected,
                "found_in_runs": list(modality_by_run),
                "modality_by_run": modality_by_run,
                "modality_vote": vote,
            }
        )

    return {
        **reports[0],
        "accepted": kept,
        "merged_from": run_names,
    }


def merge_reg(reg: str, run_suffixes: list[str] = DEFAULT_RUNS, tag: str = ".ship") -> pathlib.Path:
    paths = [COMPILED / f"{reg}{suffix}.json" for suffix in run_suffixes]
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    merged = merge_reports(reports, [path.name for path in paths])
    output = COMPILED / f"{reg}{tag}.json"
    output.write_text(json.dumps(merged, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"{reg}: merged {sum(len(report['accepted']) for report in reports)} rules into {len(merged['accepted'])} clauses -> {output.relative_to(ROOT)}")
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("regs", nargs="+")
    parser.add_argument("--runs", nargs="+", default=DEFAULT_RUNS, help="compiled input suffixes")
    parser.add_argument("--tag", default=".ship", help="compiled output suffix")
    args = parser.parse_args()
    for reg in args.regs:
        merge_reg(reg, args.runs, args.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
