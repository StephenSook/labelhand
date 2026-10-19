"""Export every graded case, misses included, for the web app's /proof page.

Two parts, both recomputed from committed files only:
  gold        each of the 46 gold-set clauses with what the shipped `.ship` rules made of it,
              using the same matching as eval/score.py
  checkback   every tank-mix hour the day-ahead forecast permitted where the station then saw a
              label limit exceeded, from eval/results/checkback-2026-10-19.json

Run: python tools/proof_export.py [--check]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "compiler"))
from compile_label import num_str  # noqa: E402
from score import ACTING, GOLD, group, quote_matches, score_label  # noqa: E402
from windows import TOPIC  # noqa: E402

COMPILED = ROOT / "data" / "compiled"
LABELS = ROOT / "data" / "labels" / "index.json"
CHECKBACK = ROOT / "eval" / "results" / "checkback-2026-10-19.json"
OUT = ROOT / "web" / "public" / "data" / "proof.json"
SUFFIX = ".ship"
TANK = "tank_mix"


def rule_view(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": rule["id"],
        "param": rule["param"],
        "op": rule.get("op"),
        "value": rule.get("value"),
        "unit": rule.get("unit"),
        "modality": rule["modality"],
        "page": rule.get("page"),
        "quote": rule["quote"],
        "acting": is_acting(rule),
    }


def same_value(rule: dict[str, Any], gold: dict[str, Any]) -> bool:
    # The same comparison eval/score.py uses for value_exact.
    if rule.get("value") is None:
        return False
    return num_str(float(rule["value"])) == num_str(float(gold["value"]))


def is_acting(rule: dict[str, Any]) -> bool:
    words = TOPIC.get(rule["param"])
    return bool(words) and rule["modality"] in ACTING and all(word in rule["quote"].lower() for word in words)


def gold_rows(reg: str, gold_items: list[dict[str, Any]], rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for gold in gold_items:
        hits = [rule for rule in rules if quote_matches(gold["key"], rule["quote"])]
        right = [rule for rule in hits if group(rule["param"]) == group(gold["param"])]
        gold_acting = gold["param"] in TOPIC and gold["modality"] in ACTING
        row: dict[str, Any] = {
            "id": gold["id"],
            "reg": reg,
            "pages": gold.get("pages", []),
            "key": gold["key"],
            "param": gold["param"],
            "value": gold.get("value"),
            "unit": gold.get("unit"),
            "modality": gold["modality"],
            "planner_must_enforce": gold_acting,
        }
        if not hits:
            row["verdict"] = "missed"
        elif not right:
            row["verdict"] = "wrong_parameter"
            row["got_params"] = sorted({rule["param"] for rule in hits})
        else:
            row["verdict"] = "matched"
            row["rules"] = [rule_view(rule) for rule in right]
            row["modality_ok"] = any(rule["modality"] == gold["modality"] for rule in right)
            row["value_ok"] = None if gold.get("value") is None else any(same_value(rule, gold) for rule in right)
        if gold_acting:
            row["enforced"] = any(is_acting(rule) for rule in right)
        rows.append(row)
    return rows


def checkback_misses(report: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, str]]:
    """Every broken tank-mix hour, plus the broken rules and stations once each, keyed by id."""
    misses = []
    rules: dict[str, Any] = {}
    stations: dict[str, str] = {}
    for row in report["details"]:
        scenario = row.get("scenarios", {}).get(TANK)
        if not scenario or scenario.get("outcome") != "broke":
            continue
        observation = row["observation"]
        stations[observation["stationId"]] = observation["stationName"]
        broken = []
        for check in scenario.get("checks", []):
            if check.get("status") != "broke":
                continue
            broken.append(check["rule"])
            rules.setdefault(
                check["rule"],
                {"reg": check["reg"], "page": check.get("page"), "param": check["param"], "quote": check["quote"], "limit": check.get("limit")},
            )
        misses.append(
            {
                "point": row["point"],
                "hour_utc": row["hour_utc"],
                "forecast_issued_utc": row["issuance"]["fetched_utc"],
                "station_id": observation["stationId"],
                "observed_utc": observation["timestamp"],
                "wind_mph": round(observation["weather"]["wind_mph"], 1),
                "broken": sorted(broken),
            }
        )
    misses.sort(key=lambda miss: (miss["hour_utc"], miss["point"]))
    return misses, rules, stations


def build() -> dict[str, Any]:
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    labels = json.loads(LABELS.read_text(encoding="utf-8"))
    products = {}
    rows: list[dict[str, Any]] = []
    for reg, items in gold["labels"].items():
        compiled = json.loads((COMPILED / f"{reg}{SUFFIX}.json").read_text(encoding="utf-8"))
        rules = compiled["accepted"]
        scored = score_label(items, rules)
        products[reg] = {
            "name": labels[reg]["shortName"],
            "accepted": labels[reg]["accepted"],
            "url": labels[reg]["url"],
            "gold": scored["gold"],
            "coverage": scored["coverage"],
            "typed": scored["typed"],
            "value_n": scored["value_n"],
            "value_ok": scored["value_ok"],
            "modality_ok": scored["modality_ok"],
            "acting_rules": scored["acting_rules"],
            "acting_good": scored["acting_good"],
            "gold_acting": scored["gold_acting"],
            "gold_acting_hit": scored["gold_acting_hit"],
            "acting_false_positives": scored["acting_false_positives"],
        }
        label_rows = gold_rows(reg, items, rules)
        # The rows must reproduce the scorer's own counts, or the page would disagree with ship.json.
        matched = [row for row in label_rows if row["verdict"] == "matched"]
        assert len(matched) == scored["typed"], reg
        assert sum(row["verdict"] != "missed" for row in label_rows) == scored["coverage"], reg
        assert sum(bool(row["modality_ok"]) for row in matched) == scored["modality_ok"], reg
        assert sum(row["value_ok"] is True for row in matched) == scored["value_ok"], reg
        assert sum(bool(row.get("enforced")) for row in label_rows) == scored["gold_acting_hit"], reg
        rows.extend(label_rows)
    report = json.loads(CHECKBACK.read_text(encoding="utf-8"))
    pooled = report[TANK]["pooled"]
    misses, broken_rules, stations = checkback_misses(report)
    assert len(misses) == pooled["broke"], "every broken hour must be listed"
    return {
        "sources": {
            "gold": GOLD.relative_to(ROOT).as_posix(),
            "rules_suffix": SUFFIX,
            "checkback": CHECKBACK.relative_to(ROOT).as_posix(),
        },
        "products": products,
        "gold": rows,
        "checkback": {
            "recorded_span": report["recorded_span"],
            "held": pooled["held"],
            "broke": pooled["broke"],
            "misses": misses,
            "rules": broken_rules,
            "stations": stations,
        },
    }


def render(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed file differs")
    args = parser.parse_args()
    text = render(build())
    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if current != text:
            print(f"{OUT.relative_to(ROOT)} is stale; run python tools/proof_export.py", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8", newline="\n")
    data = json.loads(text)
    verdicts: dict[str, int] = {}
    for row in data["gold"]:
        verdicts[row["verdict"]] = verdicts.get(row["verdict"], 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)}: gold {len(data['gold'])} {verdicts}, check-back misses {len(data['checkback']['misses'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
