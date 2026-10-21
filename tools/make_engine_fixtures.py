"""Freeze planner cases from real recorded forecasts, so every engine implementation is checked on the same inputs.

Each fixture holds the inputs (location, the tank's planner rules after the topic check, the NWS hourly periods
trimmed to the fields the kernel reads) and the Python reference output. The Rust core must reproduce
`expected` exactly; tests/test_engine_fixtures.py keeps the Python kernel and the fixtures in step.

NWS forecasts are U.S. government works. Rule quotes come from the compiled labels already in data/compiled.

Run: python tools/make_engine_fixtures.py [--points tift worth colquitt] [--hours 156] [--keep-forecast]

--keep-forecast reuses each fixture's frozen forecast and swaps only the rules, so a tank change does not
also move the replay the web app shows (it serves these periods, see web/scripts/sync-engine.mjs).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

import windows  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "engine"
TANK = ["5481-504", "228-653", "228-659"]
# Two-product tanks on a cold-night Tift forecast (the last issuance recorded on Oct 19: 52 of 80 night hours below
# 60 F), so every engine is held to the tank-mix scoping (windows.partner_missing). Folex's 60 F "use FOLEX 6 EC
# alone" clause is about Folex + thidiazuron, and FreeFall's 60 F tribufos clause is about FreeFall + tribufos, so
# each drops out of a tank without that partner. The full tank on the same forecast keeps both.
COLD_TIFT = ROOT / "web" / "public" / "data" / "season" / "tift" / "2026-10-19.json"
SUBSETS = {
    "tift-cold-full-tank": ("tift", TANK, COLD_TIFT),
    "tift-cold-folex-superboll": ("tift", ["5481-504", "228-659"], COLD_TIFT),
    "tift-cold-freefall-superboll": ("tift", ["228-653", "228-659"], COLD_TIFT),
}
PERIOD_FIELDS = ("startTime", "isDaytime", "temperature", "windSpeed", "probabilityOfPrecipitation")
RULE_FIELDS = ("id", "page", "product", "reg", "param", "op", "value", "value2", "unit", "modality", "quote", "applies_to")


def season_periods(path: pathlib.Path) -> tuple[str, list[dict]]:
    """The last recorded issuance of a season day (tools/nws_recorder.py), as NWS hourly periods."""
    issuance = json.loads(path.read_text(encoding="utf-8"))["issuances"][-1]
    start = dt.datetime.fromisoformat(issuance["first_start"])
    columns = zip(issuance["is_daytime"], issuance["temperature_f"], issuance["wind_mph"], issuance["pop"], strict=True)
    periods = [
        {
            "startTime": (start + dt.timedelta(hours=h)).isoformat(),
            "isDaytime": day,
            "temperature": temperature,
            "windSpeed": None if wind is None else f"{wind} mph",
            "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": pop},
        }
        for h, (day, temperature, wind, pop) in enumerate(columns)
    ]
    return issuance["fetched_utc"], periods


def build(point: str, hours: int, rules_suffix: str, keep_forecast: bool = False, tank: list[str] = TANK, season: pathlib.Path | None = None) -> dict:
    meta = json.loads(windows.CACHE.read_text(encoding="utf-8"))[point]
    rules = []
    for reg in tank:
        rules += windows.load_rules(reg, rules_suffix)[1]
    rules = [{k: r.get(k) for k in RULE_FIELDS} for r in rules]
    if season is not None:
        fetched, periods = season_periods(season)
    elif keep_forecast:
        frozen = json.loads((OUT / f"{point}.json").read_text(encoding="utf-8"))
        fetched, periods = frozen["forecast_fetched_utc"], frozen["periods"]
    else:
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
        "tank": tank,
        "rules": rules,
        "periods": periods,
        "expected": expected,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", nargs="+", default=["tift", "worth", "colquitt"])
    ap.add_argument("--hours", type=int, default=156)
    ap.add_argument("--rules", default=windows.DEFAULT_RULES)
    ap.add_argument("--keep-forecast", action="store_true", help="reuse each fixture's frozen forecast periods")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(point, point, TANK, None) for point in a.points]
    jobs += [(name, point, tank, season) for name, (point, tank, season) in SUBSETS.items() if point in a.points]
    for name, point, tank, season in jobs:
        fx = build(point, a.hours, a.rules, a.keep_forecast, tank, season)
        path = OUT / f"{name}.json"
        path.write_text(json.dumps(fx, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        states = [h["state"] for h in fx["expected"]]
        print(f"{path.relative_to(ROOT)}: {len(fx['rules'])} rules, {len(states)} hours, " + ", ".join(f"{s} {states.count(s)}" for s in ("PERMITTED", "FIELD_CHECK", "BLOCKED")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
