"""Freeze planner cases from real recorded forecasts, so every engine implementation is checked on the same inputs.

Each fixture holds the inputs (location, the tank's planner rules after the topic check, the NWS hourly periods
trimmed to the fields the kernel reads) and the Python reference output. The Rust core must reproduce
`expected` exactly; tests/test_engine_fixtures.py keeps the Python kernel and the fixtures in step.

NWS forecasts are U.S. government works. Rule quotes come from the compiled labels already in data/compiled.

Run: python tools/make_engine_fixtures.py [--points tift worth colquitt] [--hours 156]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

import windows  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "engine"
TANK = ["5481-504", "264-700", "264-418"]
PERIOD_FIELDS = ("startTime", "isDaytime", "temperature", "windSpeed", "probabilityOfPrecipitation")
RULE_FIELDS = ("id", "page", "product", "reg", "param", "op", "value", "value2", "unit", "modality", "quote")


def build(point: str, hours: int, rules_suffix: str) -> dict:
    meta = json.loads(windows.CACHE.read_text(encoding="utf-8"))[point]
    rules = []
    for reg in TANK:
        rules += windows.load_rules(reg, rules_suffix)[1]
    rules = [{k: r.get(k) for k in RULE_FIELDS} for r in rules]
    fetched, periods = windows.latest_forecast(point)
    periods = [{k: p.get(k) for k in PERIOD_FIELDS} for p in periods]
    expected = windows.evaluate(rules, periods, meta["lat"], meta["lon"], hours)
    return {
        "point": point,
        "lat": meta["lat"],
        "lon": meta["lon"],
        "hours": hours,
        "forecast_fetched_utc": fetched,
        "rules_suffix": rules_suffix,
        "tank": TANK,
        "rules": rules,
        "periods": periods,
        "expected": expected,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", nargs="+", default=["tift", "worth", "colquitt"])
    ap.add_argument("--hours", type=int, default=156)
    ap.add_argument("--rules", default=windows.DEFAULT_RULES)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for point in a.points:
        fx = build(point, a.hours, a.rules)
        path = OUT / f"{point}.json"
        path.write_text(json.dumps(fx, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        states = [h["state"] for h in fx["expected"]]
        print(f"{path.relative_to(ROOT)}: {len(fx['rules'])} rules, {len(states)} hours, " + ", ".join(f"{s} {states.count(s)}" for s in ("PERMITTED", "FIELD_CHECK", "BLOCKED")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
