"""Score compiled label rules against the gold set (Q1: does the compiler read labels correctly?).

Metrics, per label and overall:
  coverage_recall  gold clauses with at least one accepted rule quoting them
  typed_recall     ... where that rule also has the right parameter (same parameter group)
  value_exact      among typed matches whose gold clause has a number, the rule's value equals it
  modality_acc     among typed matches, MUST / MUST_NOT / ADVISORY agrees
  planner_precision accepted rules typed with a planner parameter that match a gold clause of that
                   parameter group; the rest are planner false positives (mistyped or out of scope)

Run: python eval/score.py [--suffix .typed] [--out eval/results/NAME.json]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))
sys.path.insert(0, str(ROOT / "engine"))
from compile_label import norm, num_str, squash  # noqa: E402
from windows import TOPIC  # noqa: E402  (the same filter the planner applies)

GOLD = ROOT / "eval" / "gold_v0.json"
COMPILED = ROOT / "data" / "compiled"
GROUPS = [{"release_height_ft", "boom_height_in"}, {"rain_free_hours", "rainfall_expected"}]
PLANNER = {
    "wind_speed_mph",
    "temperature_inversion",
    "rain_free_hours",
    "rainfall_expected",
    "air_temperature_f",
    "night_temperature_f",
    "open_boll_pct",
    "buffer_ft",
    "release_height_ft",
    "boom_height_in",
    "droplet_size",
    "reentry_hours",
}


def group(param: str) -> frozenset:
    for g in GROUPS:
        if param in g:
            return frozenset(g)
    return frozenset({param})


def quote_matches(gold_key: str, quote: str) -> bool:
    a, b = squash(norm(gold_key)), squash(norm(quote))
    return a in b or (len(b) >= 20 and b in a)


def score_label(gold_items: list[dict], rules: list[dict]) -> dict:
    cov = typed = val_n = val_ok = mod_ok = 0
    misses, mistyped = [], []
    for g in gold_items:
        hits = [r for r in rules if quote_matches(g["key"], r["quote"])]
        if not hits:
            misses.append(g["id"])
            continue
        cov += 1
        right = [r for r in hits if group(r["param"]) == group(g["param"])]
        if not right:
            mistyped.append({"gold": g["id"], "got": sorted({r["param"] for r in hits})})
            continue
        typed += 1
        if any(r["modality"] == g["modality"] for r in right):
            mod_ok += 1
        if g.get("value") is not None:
            val_n += 1
            if any(r["value"] is not None and num_str(float(r["value"])) == num_str(float(g["value"])) for r in right):
                val_ok += 1

    def matches_gold(r: dict) -> bool:
        return any(quote_matches(g["key"], r["quote"]) and group(g["param"]) == group(r["param"]) for g in gold_items)

    planner_rules = [r for r in rules if r["param"] in PLANNER]
    good = [r for r in planner_rules if matches_gold(r)]
    false_pos = [{"id": r["id"], "param": r["param"], "modality": r["modality"], "quote": r["quote"][:120]} for r in planner_rules if r not in good]
    # Acting rules: the ones engine/windows.py can turn into BLOCKED or FIELD_CHECK (a parameter it evaluates,
    # a MUST or MUST_NOT modality, and the topic word in the quote). A wrong acting rule changes an hour's state;
    # a wrong advisory rule only adds a note. This is the precision that matters for harm.
    acting = [r for r in rules if r["param"] in TOPIC and r["modality"] in ("MUST", "MUST_NOT") and all(w in r["quote"].lower() for w in TOPIC[r["param"]])]
    acting_good = [r for r in acting if matches_gold(r)]
    acting_fp = [{"id": r["id"], "param": r["param"], "quote": r["quote"][:120]} for r in acting if r not in acting_good]
    # Acting recall: gold clauses the planner must enforce, and whether an acting rule enforces each one.
    gold_acting = [g for g in gold_items if g["param"] in TOPIC and g["modality"] in ("MUST", "MUST_NOT")]
    gold_acting_hit = [g for g in gold_acting if any(quote_matches(g["key"], r["quote"]) and group(g["param"]) == group(r["param"]) for r in acting)]
    acting_missed = [g["id"] for g in gold_acting if g not in gold_acting_hit]
    n = len(gold_items)
    return {
        "gold": n,
        "coverage": cov,
        "typed": typed,
        "value_n": val_n,
        "value_ok": val_ok,
        "modality_ok": mod_ok,
        "planner_rules": len(planner_rules),
        "planner_good": len(good),
        "coverage_recall": round(cov / n, 3),
        "typed_recall": round(typed / n, 3),
        "value_exact": round(val_ok / val_n, 3) if val_n else None,
        "modality_acc": round(mod_ok / typed, 3) if typed else None,
        "planner_precision": round(len(good) / len(planner_rules), 3) if planner_rules else None,
        "acting_rules": len(acting),
        "acting_good": len(acting_good),
        "acting_precision": round(len(acting_good) / len(acting), 3) if acting else None,
        "gold_acting": len(gold_acting),
        "gold_acting_hit": len(gold_acting_hit),
        "acting_recall": round(len(gold_acting_hit) / len(gold_acting), 3) if gold_acting else None,
        "acting_missed": acting_missed,
        "missed": misses,
        "mistyped": mistyped,
        "planner_false_positives": false_pos,
        "acting_false_positives": acting_fp,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--suffix", default="", help="compiled file suffix, e.g. .typed or .union")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    report, tot = {"suffix": a.suffix, "labels": {}}, {}
    for reg, items in gold["labels"].items():
        comp = json.loads((COMPILED / f"{reg}{a.suffix}.json").read_text(encoding="utf-8"))
        s = score_label(items, comp["accepted"])
        s["model"] = comp.get("model")
        report["labels"][reg] = s
        for k in (
            "gold",
            "coverage",
            "typed",
            "value_n",
            "value_ok",
            "modality_ok",
            "planner_rules",
            "planner_good",
            "acting_rules",
            "acting_good",
            "gold_acting",
            "gold_acting_hit",
        ):
            tot[k] = tot.get(k, 0) + s[k]
        print(
            f"{reg}: coverage {s['coverage']}/{s['gold']} typed {s['typed']} value {s['value_ok']}/{s['value_n']} "
            f"modality {s['modality_ok']}/{s['typed']} planner precision {s['planner_good']}/{s['planner_rules']}"
        )
    report["overall"] = {
        **tot,
        "coverage_recall": round(tot["coverage"] / tot["gold"], 3),
        "typed_recall": round(tot["typed"] / tot["gold"], 3),
        "value_exact": round(tot["value_ok"] / tot["value_n"], 3) if tot["value_n"] else None,
        "modality_acc": round(tot["modality_ok"] / tot["typed"], 3) if tot["typed"] else None,
        "planner_precision": round(tot["planner_good"] / tot["planner_rules"], 3) if tot["planner_rules"] else None,
        "acting_precision": round(tot["acting_good"] / tot["acting_rules"], 3) if tot["acting_rules"] else None,
        "acting_recall": round(tot["gold_acting_hit"] / tot["gold_acting"], 3) if tot["gold_acting"] else None,
    }
    o = report["overall"]
    print(
        f"OVERALL coverage recall {o['coverage_recall']} | typed recall {o['typed_recall']} | value exact {o['value_exact']} | "
        f"modality {o['modality_acc']} | planner precision {o['planner_precision']} | acting precision {o['acting_precision']} "
        f"({o['acting_good']}/{o['acting_rules']}) | acting recall {o['acting_recall']} ({o['gold_acting_hit']}/{o['gold_acting']})"
    )
    if a.out:
        pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(a.out).write_text(json.dumps(report, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
