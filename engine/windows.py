"""Planner kernel: compiled label rules + NWS hourly forecast -> hour-by-hour spray states for a tank mix.

States (never the word "legal"):
  PERMITTED     every planner rule of every product in the tank is satisfied by the forecast for that hour
  BLOCKED       at least one rule is violated; the reason carries the product, rule id, page and exact quote
  FIELD_CHECK   the forecast cannot decide (inversion, gusts, borderline rain chance); the applicator checks on site

Rules reach the planner only after two deterministic filters:
  1. the compiler's guards (verbatim quote, numbers present in the quote), and
  2. a topic check here: the quote must contain the words of the parameter it was typed as. A clause about
     a nurse tank typed as night temperature never decides an hour.

This is the Python reference implementation. The Rust core (wasm + UniFFI) must produce identical output
on the same inputs; tests/fixtures hold the shared cases.

Run: python engine/windows.py --point tift --tank 5481-504 264-700 264-418 --hours 48
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import gzip
import json
import math
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
COMPILED = ROOT / "data" / "compiled"
RECORDED = ROOT / "data" / "nws_recorded"
CACHE = ROOT / "data" / "nws_points_cache.json"

# Topic words a quote must contain for a rule typed with this parameter to drive the planner.
TOPIC = {
    "wind_speed_mph": ("wind",),
    "temperature_inversion": ("inversion",),
    "rain_free_hours": ("rain",),
    "rainfall_expected": ("rain",),
    "night_temperature_f": ("night",),
    "air_temperature_f": ("temperature",),
}
# A rain chance at or above this is treated as "rain expected". The labels do not define "expected";
# the threshold is ours, shown to the user, and configurable. Between the two values the hour is a field check.
RAIN_EXPECTED_POP = 50
RAIN_UNSURE_POP = 20


def load_rules(reg: str) -> tuple[str, list[dict], list[dict]]:
    rep = json.loads((COMPILED / f"{reg}.json").read_text(encoding="utf-8"))
    used, skipped, seen = [], [], set()
    for r in rep["accepted"]:
        words = TOPIC.get(r["param"])
        if not words:
            continue
        q = r["quote"].lower()
        key = (r["param"], re.sub(r"\W+", "", q))
        if key in seen:
            continue  # same clause compiled twice
        seen.add(key)
        if all(w in q for w in words):
            used.append({**r, "product": rep["product"], "reg": reg})
        else:
            skipped.append({"id": r["id"], "param": r["param"], "why": f"quote lacks {words}"})
    return rep["product"], used, skipped


def latest_forecast(point: str) -> tuple[str, list[dict]]:
    files = sorted(glob.glob(str(RECORDED / "*" / f"*_{point}_hourly.json.gz")))
    if not files:
        raise SystemExit(f"no recorded forecast for {point}")
    rec = json.load(gzip.open(files[-1], "rt", encoding="utf-8"))
    return rec["fetched_utc"], rec["data"]["periods"]


def mph(s: str) -> float:
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", s or "")]
    return max(nums) if nums else math.nan  # "5 to 10 mph" -> 10: plan for the worst of the range


def sun_altitude(lat: float, lon: float, t: dt.datetime) -> float:
    """Solar elevation in degrees (NOAA approximation, good to about half a degree)."""
    t = t.astimezone(dt.UTC)
    doy = t.timetuple().tm_yday
    hour = t.hour + t.minute / 60
    g = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)
    decl = (
        0.006918
        - 0.399912 * math.cos(g)
        + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g)
        + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g)
        + 0.00148 * math.sin(3 * g)
    )
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    tst = hour * 60 + eqt + 4 * lon
    ha = math.radians(tst / 4 - 180)
    la = math.radians(lat)
    cz = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)
    return math.degrees(math.asin(max(-1.0, min(1.0, cz))))


def evaluate(rules: list[dict], periods: list[dict], lat: float, lon: float, hours: int) -> list[dict]:
    out = []
    for i, p in enumerate(periods[:hours]):
        t = dt.datetime.fromisoformat(p["startTime"])
        wind = mph(p.get("windSpeed", ""))
        pop_ahead = {}
        blocked, checks = [], []
        alt = sun_altitude(lat, lon, t)
        for r in rules:
            cite = {"product": r["product"], "rule": r["id"], "page": r["page"], "quote": r["quote"]}
            if r["param"] == "wind_speed_mph" and r["value"] is not None and not math.isnan(wind):
                limit = float(r["value"])
                if r["op"] in ("gt", "lte") and r["value"] >= 5 and wind > limit:
                    blocked.append({**cite, "why": f"forecast wind up to {wind:g} mph > {limit:g} mph"})
                elif r["op"] in ("lt",) and limit <= 3 and wind < limit:
                    checks.append({**cite, "why": f"forecast wind {wind:g} mph < {limit:g} mph: variable direction, inversion potential"})
            elif r["param"] == "temperature_inversion" and r["modality"] == "MUST_NOT":
                if alt < 3 or (alt < 20 and not math.isnan(wind) and wind < 3):
                    checks.append({**cite, "why": f"sun {alt:.0f} deg, wind {wind:g} mph: inversion possible, confirm on site"})
            elif r["param"] in ("rain_free_hours", "rainfall_expected") and r["modality"] == "MUST_NOT" and r["value"]:
                n = int(r["value"])
                if n not in pop_ahead:
                    window = periods[i : i + n + 1]
                    pop_ahead[n] = max((q.get("probabilityOfPrecipitation") or {}).get("value") or 0 for q in window)
                pop = pop_ahead[n]
                if pop >= RAIN_EXPECTED_POP:
                    blocked.append({**cite, "why": f"rain chance up to {pop}% within {n} h (rain expected = {RAIN_EXPECTED_POP}%+)"})
                elif pop >= RAIN_UNSURE_POP:
                    checks.append({**cite, "why": f"rain chance up to {pop}% within {n} h"})
        state = "BLOCKED" if blocked else ("FIELD_CHECK" if checks else "PERMITTED")
        out.append(
            {
                "start": p["startTime"],
                "state": state,
                "temp_f": p.get("temperature"),
                "wind": p.get("windSpeed"),
                "pop": (p.get("probabilityOfPrecipitation") or {}).get("value"),
                "sun_alt": round(alt, 1),
                "blocked": blocked,
                "checks": checks,
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--point", default="tift")
    ap.add_argument("--tank", nargs="+", default=["5481-504", "264-700", "264-418"])
    ap.add_argument("--hours", type=int, default=48)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    meta = json.loads(CACHE.read_text(encoding="utf-8"))[a.point]
    rules, skipped = [], []
    for reg in a.tank:
        _, u, s = load_rules(reg)
        rules += u
        skipped += s
    fetched, periods = latest_forecast(a.point)
    hours = evaluate(rules, periods, meta["lat"], meta["lon"], a.hours)
    if a.json:
        print(json.dumps({"point": a.point, "forecast_fetched_utc": fetched, "rules_used": len(rules), "rules_skipped": skipped, "hours": hours}, indent=1))
        return 0
    print(f"{a.point} forecast fetched {fetched} | planner rules {len(rules)} (topic-check skipped {len(skipped)})")
    for h in hours:
        first = (h["blocked"] or h["checks"] or [{}])[0]
        why = f"{first.get('product', '')[:12]} p{first.get('page', '')}: {first.get('why', '')}" if first else ""
        print(f"{h['start'][5:16]} {h['state']:11} {str(h['temp_f']):>3}F {h['wind']:>12} pop {str(h['pop']):>3}% sun {h['sun_alt']:>5} | {why}")
    permitted = sum(h["state"] == "PERMITTED" for h in hours)
    print(f"PERMITTED {permitted} / FIELD_CHECK {sum(h['state'] == 'FIELD_CHECK' for h in hours)} / BLOCKED {sum(h['state'] == 'BLOCKED' for h in hours)} of {len(hours)} hours")
    return 0


if __name__ == "__main__":
    sys.exit(main())
