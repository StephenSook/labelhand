"""Compile the label version EPA accepted just before each shipped label, with the shipped pipeline unchanged.

The label time machine (web /changes) compares a shipped label with the version before it. Where both versions
are compiled it also compares their rules and the planner hours they decide. This tool compiles that earlier
version once, the way FreeFall SC and Super Boll were compiled for the shipped tank: three runs of

    Nemotron 3 Super and Nemotron 3 Ultra extraction (prompt p2)  compiler/compile_label.py
    union of the two passes                                         compiler/union.py
    Nemotron 3 Ultra typing v3                                      compiler/retype.py
    second reading (no OCR file, written through)                   compiler/two_readings.py
    EPA PR Notice 2000-5 modality floor                             compiler/modality.py

then the majority merge (compiler/merge_runs.py). Each step runs through its own command-line entry point with the
same arguments the shipped runs used. Only two module paths differ: the label index the steps read and the folder
they write, so nothing in data/compiled itself is touched. No prompt, model, schema or guard is changed.

A version whose PDF has no readable text layer is not compiled. The compiler reads the PDF text layer, so a scan
would give the model empty pages and the merge would report every shipped rule as removed. The test is the one the
live compile uses (web/src/lib/compiler/pdf-text.ts readableTextGate): more than a quarter of the pages under
50 characters, or any page more than 1% unreadable glyphs.

Outputs:
    data/compiled/previous/index.json                one entry per earlier version, shaped like data/labels/index.json
    data/compiled/previous/<reg>.*.json              every step's file, named as in data/compiled
    eval/results/previous-compile-<date>.json        what was compiled, what was not and why, and the Token Factory cost

Token Factory spend stops before a run that could pass --budget (default $4): the estimate for a run is the larger
of the last run of the same label and the shipped label's own most expensive run.

Run: python tools/previous_compile.py 5481-504 228-653 228-659 [--budget 4]
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import pathlib
import sys
import time
from collections.abc import Callable, Iterator

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "tools"))

import compile_label  # noqa: E402
import merge_runs  # noqa: E402
import modality  # noqa: E402
import ppls_fetch  # noqa: E402
import retype  # noqa: E402
import two_readings  # noqa: E402
import union  # noqa: E402

SHIPPED_INDEX = ROOT / "data" / "labels" / "index.json"
SHIPPED = ROOT / "data" / "compiled"
OUT = SHIPPED / "previous"
RESULTS = ROOT / "eval" / "results"
LABELS = ROOT / "data" / "labels"

ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b"
ULTRA_PASS = "." + ULTRA.split("/")[-1]
RUNS = (".p2", ".p2r2", ".p2r3")
NEAR_EMPTY_CHARACTERS = 50
MAX_REPLACEMENT_SHARE = 0.01


class BudgetStop(Exception):
    """The next run could take Token Factory spend past the budget."""


def previous_version(versions: list[dict], shipped_accepted: str) -> dict | None:
    """The version accepted just before the shipped one, from a newest-first list; None when the shipped one is the oldest."""
    dates = [v["accepted"] for v in versions]
    if shipped_accepted not in dates:
        raise RuntimeError(f"PPLS does not list the shipped label accepted {shipped_accepted} (listed: {', '.join(dates)})")
    older = [v for v in versions if v["accepted"] < shipped_accepted]
    return older[0] if older else None


def readable_text(pages: list[str]) -> str | None:
    """None when the text layer can be compiled, else the reason it cannot (the live compile's gate)."""
    if not pages:
        return "The PDF has no pages."
    for n, page in enumerate(pages, start=1):
        if page.count(chr(0xFFFD)) / max(1, len(page)) > MAX_REPLACEMENT_SHARE:
            return f"Page {n} has an unreadable text layer."
    near_empty = sum(1 for page in pages if len(page.strip()) < NEAR_EMPTY_CHARACTERS)
    if near_empty > len(pages) / 4:
        return f"{near_empty} of {len(pages)} pages have no readable text layer; the PDF is a scan."
    return None


def steps(reg: str) -> list[tuple[str, list[str]]]:
    """Every pipeline step, as (module, argv), in the order the shipped runs used."""
    out: list[tuple[str, list[str]]] = []
    for tag in RUNS:
        out += [
            ("compile_label", [reg, "--tag", tag]),
            ("compile_label", [reg, "--model", ULTRA, "--tag", tag]),
            ("union", [reg, "--passes", tag, ULTRA_PASS + tag, "--tag", tag]),
            ("retype", [reg, "--suffix", f".union{tag}", "--tag", ".v3"]),
            ("two_readings", [reg, "--suffix", f".union{tag}.typed.v3"]),
            ("modality", [reg, "--suffix", f".union{tag}.typed.v3.ocr", "--tag", ".mf"]),
        ]
    out.append(("merge_runs", [reg]))
    return out


MODULES = {
    "compile_label": compile_label,
    "union": union,
    "retype": retype,
    "two_readings": two_readings,
    "modality": modality,
    "merge_runs": merge_runs,
}


@contextlib.contextmanager
def sandbox(out_dir: pathlib.Path, index: pathlib.Path) -> Iterator[None]:
    """Point every pipeline module at the earlier versions' index and folder, and put the shipped paths back after."""
    targets = [
        (compile_label, "INDEX", index),
        (compile_label, "OUT", out_dir),
        (union, "COMPILED", out_dir),
        (retype, "COMPILED", out_dir),
        (two_readings, "COMPILED", out_dir),
        (two_readings, "INDEX", index),
        (two_readings, "TEXT", out_dir / "no-ocr"),  # the shipped runs had no OCR file for these labels
        (modality, "COMPILED", out_dir),
        (modality, "INDEX", index),
        (merge_runs, "COMPILED", out_dir),
    ]
    saved = [(module, name, getattr(module, name)) for module, name, _ in targets]
    try:
        for module, name, value in targets:
            setattr(module, name, value)
        yield
    finally:
        for module, name, value in saved:
            setattr(module, name, value)


def run_step(name: str, argv: list[str]) -> None:
    saved = sys.argv
    sys.argv = [f"{name}.py", *argv]
    try:
        code = MODULES[name].main()
    finally:
        sys.argv = saved
    if code:
        raise RuntimeError(f"{name} {' '.join(argv)} exited {code}; the compile stops here")


def run_cost(out_dir: pathlib.Path, reg: str, tag: str) -> dict:
    """Token Factory cost of one run, from its own files (two extraction passes, typing, OCR-rescue typing)."""

    def read(suffix: str) -> dict:
        return json.loads((out_dir / f"{reg}{suffix}.json").read_text(encoding="utf-8"))

    super_pass, ultra_pass = read(tag), read(ULTRA_PASS + tag)
    final = read(f".union{tag}.typed.v3.ocr.mf")
    cost = {
        "super_usd": super_pass["cost_usd"],
        "ultra_usd": ultra_pass["cost_usd"],
        "typing_usd": final["retype_cost_usd"],
        "ocr_rescue_usd": final.get("ocr_rescue_cost_usd", 0.0),
    }
    cost["total_usd"] = round(sum(cost.values()), 4)
    return cost


def shipped_run_cost(reg: str) -> float:
    """The most expensive shipped run of a label, as the estimate for its earlier version's first run."""
    most = 0.0
    for tag in RUNS:
        final = json.loads((SHIPPED / f"{reg}.union{tag}.typed.v3.ocr.mf.json").read_text(encoding="utf-8"))
        most = max(most, final["cost_usd"] + final["retype_cost_usd"] + final.get("ocr_rescue_cost_usd", 0.0))
    return round(most, 4)


def compile_previous(
    reg: str,
    out_dir: pathlib.Path,
    index: pathlib.Path,
    spent: float,
    budget: float,
    estimate: float,
    step: Callable[[str, list[str]], None] = run_step,
    runs: list[dict] | None = None,
) -> list[dict]:
    """Run the shipped pipeline on the earlier version of one label. Returns each run's cost.

    Each finished run is appended to `runs` as it completes, so a caller still knows what was spent when a later run
    stops on the budget or fails.
    """
    runs = [] if runs is None else runs
    with sandbox(out_dir, index):
        plan = steps(reg)
        per_run = (len(plan) - 1) // len(RUNS)
        for n, tag in enumerate(RUNS):
            guess = max(estimate, *(r["total_usd"] for r in runs)) if runs else estimate
            if spent + guess > budget:
                raise BudgetStop(f"{reg} run {tag}: ${spent:.4f} spent, next run estimated ${guess:.4f}, budget ${budget:.2f}")
            for name, argv in plan[n * per_run : (n + 1) * per_run]:
                step(name, argv)
            cost = run_cost(out_dir, reg, tag)
            spent += cost["total_usd"]
            runs.append({"run": tag, **cost})
        step(*plan[-1])
    return runs


def download(version: dict) -> tuple[pathlib.Path, bytes]:
    body = ppls_fetch._get(version["url"], timeout=180)
    if not body.startswith(b"%PDF-") or len(body) < 20_000:
        raise RuntimeError(f"{version['url']} did not return a PDF ({len(body)} bytes, starts {body[:8]!r})")
    path = LABELS / pathlib.Path(version["url"]).name
    path.write_bytes(body)
    return path, body


def main() -> int:
    from pypdf import PdfReader

    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--budget", type=float, default=4.0, help="stop before Token Factory spend could pass this many USD")
    a = ap.parse_args()

    shipped_index = json.loads(SHIPPED_INDEX.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    receipt: dict = {
        "created_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "pipeline": "three runs of p2 Super + Ultra extraction, union, Ultra typing v3, two readings, modality floor, majority merge",
        "budget_usd": a.budget,
        "labels": {},
    }
    spent = 0.0
    try:
        for reg in a.regs:
            shipped = shipped_index[reg]
            _, versions = ppls_fetch.list_versions(reg)
            version = previous_version(versions, shipped["accepted"])
            entry = {"reg": reg, "shipped_accepted": shipped["accepted"], "shipped_sha256": shipped["sha256"], "versions_listed": len(versions)}
            if version is None:
                receipt["labels"][reg] = {**entry, "compiled": False, "why": "PPLS lists no earlier accepted label for this registration."}
                print(f"{reg}: no earlier version")
                continue
            path, body = download(version)
            pages = [p.extract_text() or "" for p in PdfReader(path).pages]
            record = {
                "reg": reg,
                "product": shipped["product"],
                "shortName": shipped.get("shortName", shipped["product"]),
                "accepted": version["accepted"],
                "url": version["url"],
                "file": str(path.relative_to(ROOT)).replace("\\", "/"),
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
                "pages": len(pages),
                "versions_listed": len(versions),
                "fetched_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                "shipped_accepted": shipped["accepted"],
                "shipped_sha256": shipped["sha256"],
            }
            index[reg] = record
            index_path.write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
            entry = {**entry, "accepted": record["accepted"], "url": record["url"], "sha256": record["sha256"], "pages": record["pages"]}
            why = readable_text(pages)
            if why:
                receipt["labels"][reg] = {**entry, "compiled": False, "why": why, "page_characters": [len(p.strip()) for p in pages]}
                print(f"{reg} {record['accepted']}: not compiled. {why}")
                continue
            runs: list[dict] = []
            try:
                compile_previous(reg, OUT, index_path, spent, a.budget, shipped_run_cost(reg), runs=runs)
            except BaseException as stop:
                # Runs that finished before the stop were paid for; they stay in the receipt and the total.
                spent += sum(r["total_usd"] for r in runs)
                why = f"Stopped by the budget: {stop}" if isinstance(stop, BudgetStop) else f"Failed: {type(stop).__name__}: {stop}"
                receipt["labels"][reg] = {**entry, "compiled": False, "why": why, "runs": runs}
                print(f"STOP {why}")
                if isinstance(stop, BudgetStop):
                    break
                raise
            cost = round(sum(r["total_usd"] for r in runs), 4)
            spent += cost
            merged = json.loads((OUT / f"{reg}.ship.json").read_text(encoding="utf-8"))
            receipt["labels"][reg] = {**entry, "compiled": True, "runs": runs, "cost_usd": cost, "merged_rules": len(merged["accepted"])}
            print(f"{reg} {record['accepted']}: compiled, {len(merged['accepted'])} merged rules, ${cost} (total ${spent:.4f})")
            time.sleep(3)  # be polite to EPA between labels
    finally:
        # Written even when a step fails, so the spend of every finished run is recorded. A run that fails partway is
        # not counted (its passes' own files still carry their cost). Nothing is written when no label was reached,
        # so a mistyped registration does not replace an earlier receipt with an empty one.
        if receipt["labels"]:
            receipt["total_cost_usd"] = round(spent, 4)
            out = RESULTS / f"previous-compile-{dt.date.today().isoformat()}.json"
            out.write_text(json.dumps(receipt, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
            print(f"wrote {out.relative_to(ROOT)}; Token Factory spend ${spent:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
