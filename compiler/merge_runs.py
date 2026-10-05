"""Merge accepted rules from repeated compiler runs into one shipped rule set.

Rules use the same dedupe key as engine/windows.py: parameter plus the lowercased quote with
every run of non-word characters removed. When duplicate rules disagree on modality, the first
acting rule wins over an advisory rule. Otherwise the first rule wins.

Run:
    python compiler/merge_runs.py 5481-504 264-700 264-418
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

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


def merge_reports(reports: list[dict], run_names: list[str]) -> dict:
    if not reports or len(reports) != len(run_names):
        raise ValueError("reports and run_names must be non-empty and have the same length")

    product = reports[0].get("product")
    reg = reports[0].get("reg")
    if any(report.get("product") != product or report.get("reg") != reg for report in reports[1:]):
        raise ValueError("all merged reports must describe the same product and registration")

    kept: dict[tuple[str, str], dict] = {}
    for report, run_name in zip(reports, run_names, strict=True):
        for rule in report["accepted"]:
            key = rule_key(rule)
            if key not in kept:
                kept[key] = {
                    **rule,
                    "found_in_runs": [run_name],
                    "modality_by_run": {run_name: rule["modality"]},
                }
                continue

            current = kept[key]
            if run_name not in current["found_in_runs"]:
                current["found_in_runs"].append(run_name)
            previous_for_run = current["modality_by_run"].get(run_name)
            current["modality_by_run"][run_name] = rule["modality"] if previous_for_run is None else _preferred_modality(previous_for_run, rule["modality"])

            if current["modality"] not in ACTING and rule["modality"] in ACTING:
                kept[key] = {
                    **rule,
                    "found_in_runs": current["found_in_runs"],
                    "modality_by_run": current["modality_by_run"],
                }

    return {
        **reports[0],
        "accepted": list(kept.values()),
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
