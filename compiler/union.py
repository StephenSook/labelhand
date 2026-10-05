"""Union two independent extraction passes of the same label, so a clause one model skips is still compiled.

Rules are deduplicated on (page, whitespace-free normalised quote). Each kept rule records which passes
found it. Both inputs already passed the compiler's guards, so the union adds no unverified text.

Output: data/compiled/<reg>.union.json, ready for compiler/retype.py --suffix .union

Run: python compiler/union.py 5481-504 264-700 264-418 [--passes "" .Nemotron-3-Ultra-550b-a55b]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

from compile_label import OUT as COMPILED
from compile_label import norm, squash

DEFAULT_PASSES = ["", ".Nemotron-3-Ultra-550b-a55b"]


def union(reg: str, passes: list[str]) -> dict:
    reports = [json.loads((COMPILED / f"{reg}{s}.json").read_text(encoding="utf-8")) for s in passes]
    kept: dict[tuple, dict] = {}
    for rep in reports:
        for r in rep["accepted"]:
            k = (r["page"], squash(norm(r["quote"])), r["param"])
            if k in kept:
                kept[k]["found_by"].append(rep["model"])
                continue
            kept[k] = {**r, "found_by": [rep["model"]]}
    # Same quote typed two ways by the two passes: keep both for now; the typing pass settles the type.
    base = reports[0]
    return {
        **{k: v for k, v in base.items() if k not in ("accepted", "rejected", "model", "tokens_in", "tokens_out", "cost_usd")},
        "union_of": [rep["model"] for rep in reports],
        "union_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "model": "+".join(rep["model"] for rep in reports),
        "cost_usd": round(sum(rep.get("cost_usd", 0) for rep in reports), 4),
        "accepted": list(kept.values()),
        "rejected": [x for rep in reports for x in rep["rejected"]],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--passes", nargs="+", default=DEFAULT_PASSES)
    ap.add_argument("--tag", default="", help="appended to the output name")
    a = ap.parse_args()
    for reg in a.regs:
        u = union(reg, a.passes)
        (COMPILED / f"{reg}.union{a.tag}.json").write_text(json.dumps(u, indent=1), encoding="utf-8")
        both = sum(1 for r in u["accepted"] if len(r["found_by"]) > 1)
        print(f"{reg}: union {len(u['accepted'])} rules ({both} found by both passes) cost ${u['cost_usd']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
