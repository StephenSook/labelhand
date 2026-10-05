"""Planner kernel: compiled label rules + NWS hourly forecast -> hour-by-hour spray states for a tank mix.

States (never the word "legal"):
  PERMITTED     every planner rule of every product in the tank is satisfied by the forecast for that hour
  BLOCKED       at least one rule is violated; the reason carries the product, rule id, page and exact quote
  FIELD_CHECK   the forecast cannot decide (inversion, gusts, borderline rain chance); the applicator checks on site

Advisories never change the state. They are label statements of effect ("unsatisfactory defoliation may
result") whose weather condition the forecast meets, each with its quote and the window it was checked over.

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
# Window for temperature advisories: the night low and the mean are taken over the next 24 forecast hours.
ADVISORY_HOURS = 24


# Shipped configuration: majority modality vote across three p2 + typing v3 + OCR + PR 2000-5 floor runs.
# Gold v0 (eval/results/ship.json): coverage recall 1.0, typed recall 1.0, value exact 0.944, modality 0.87,
# planner precision 0.635, strict acting precision 1.0 (12/12), and acting recall 1.0 (10/10).
DEFAULT_RULES = ".ship"


def load_rules(reg: str, rules_suffix: str = DEFAULT_RULES) -> tuple[str, list[dict], list[dict]]:
    rep = json.loads((COMPILED / f"{reg}{rules_suffix}.json").read_text(encoding="utf-8"))
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


def max_pop(periods: list[dict]) -> int:
    return max(((q.get("probabilityOfPrecipitation") or {}).get("value") or 0 for q in periods), default=0)


SYMBOL = {"lt": "<", "lte": "<=", "gt": ">", "gte": ">="}


def holds(x: float, op: str, v: float) -> bool:
    return {"lt": x < v, "lte": x <= v, "gt": x > v, "gte": x >= v}[op]


TEMPERATURE = ("night_temperature_f", "air_temperature_f")
ALONE_TANK = re.compile(r"\buse\b[^.]*\balone\b")


def tank_composition_clause(r: dict) -> bool:
    """Whether an acting temperature clause requires its product to be used alone."""
    return r["modality"] in ("MUST", "MUST_NOT") and r["param"] in TEMPERATURE and ALONE_TANK.search(r["quote"].lower()) is not None


def temperature_condition(r: dict, i: int, periods: list[dict]) -> str | None:
    """Why the temperature condition a clause names holds in the forecast from hour i, or None.

    Night clauses read the lowest night-time temperature, "mean" clauses the forecast mean, others this hour,
    always over the next ADVISORY_HOURS hours that the forecast covers.
    """
    if r["value"] is None or r["op"] not in SYMBOL:
        return None
    v = float(r["value"])
    ahead = periods[i : i + ADVISORY_HOURS]
    if r["param"] == "night_temperature_f":
        temps = [q["temperature"] for q in ahead if q.get("isDaytime") is False and q.get("temperature") is not None]
        x, what = (min(temps), "night low") if temps else (None, "")
    else:
        temps = [q["temperature"] for q in ahead if q.get("temperature") is not None]
        if "mean" in r["quote"].lower():
            x, what = (sum(temps) / len(temps), "mean") if temps else (None, "")
        else:
            x, what = (float(temps[0]), "temperature now") if temps else (None, "")
    if x is None or not holds(x, r["op"], v):
        return None
    span = "this hour" if what == "temperature now" else f"over the next {len(ahead)} h"
    return f"forecast {what} {x:.0f} F {SYMBOL[r['op']]} {v:g} F {span}"


def advisory(r: dict, i: int, periods: list[dict], wind: float = math.nan) -> str | None:
    """Why the weather condition an ADVISORY clause names holds in the forecast at hour i, or None.

    The kernel does not decide whether a clause is a warning or a recommendation; the quote says that, and it
    travels with the advisory. Advisories never change the hour's state.
    """
    if r["param"] == "wind_speed_mph":
        upper, upper_out, lower, lower_out = wind_limits(r)
        if math.isnan(wind):
            return None
        if upper is not None and (wind > upper or (upper_out and wind == upper)):
            return f"forecast wind up to {wind:g} mph {'>' if wind > upper else '='} {upper:g} mph"
        if lower is not None and (wind < lower or (lower_out and wind == lower)):
            return f"forecast wind {wind:g} mph {'<' if wind < lower else '='} {lower:g} mph"
        return None
    if r["value"] is None:
        return None
    v = float(r["value"])
    if r["param"] in TEMPERATURE:
        return temperature_condition(r, i, periods)
    if r["param"] in ("rain_free_hours", "rainfall_expected"):
        n = int(v)
        pop = max_pop(periods[i : i + n + 1])
        if pop >= RAIN_UNSURE_POP:
            return f"rain chance up to {pop}% within {n} h"
    return None


def wind_limits(r: dict) -> tuple[float | None, bool, float | None, bool]:
    """(upper, at_upper_is_out, lower, at_lower_is_out): the wind bounds a clause sets.

    Bounds are read by magnitude, because the typing model is not consistent about operator direction
    ("Do not apply when wind speeds exceed 10 mph" arrives as gt 10 and as lte 10). The operator still says
    whether the bound itself is allowed: "exceed 10" (gt, lte) allows 10; "less than 10" (lt) and
    "10 or more" (gte) do not.
    """
    op = r["op"]
    v = None if r["value"] is None else float(r["value"])
    v2 = None if r.get("value2") is None else float(r["value2"])
    if op == "between" and v is not None and v2 is not None:
        return v2, False, v, False
    if v is None or op not in ("gt", "gte", "lt", "lte"):
        return None, False, None, False
    if v >= 5:
        return v, op in ("lt", "gte"), None, False
    if v <= 3:
        return None, False, v, op in ("gt", "lte")
    return None, False, None, False


def gate(r: dict, i: int, periods: list[dict], wind: float, alt: float, tank_products: set[str]) -> tuple[str, str] | None:
    """("BLOCKED" or "FIELD_CHECK", why) for a MUST or MUST_NOT clause at hour i, or None when it is satisfied.

    A clause the kernel cannot evaluate is a FIELD_CHECK that says so: an acting clause is never silently skipped.
    """
    param = r["param"]
    if tank_composition_clause(r):
        why = temperature_condition(r, i, periods)
        if not why:
            return None
        other_products = sorted(tank_products - {r["product"]})
        if other_products:
            return "BLOCKED", f"{why}: the label says use {r['product']} alone, and this tank also has {', '.join(other_products)}"
        return None
    if param == "wind_speed_mph":
        upper, upper_out, lower, lower_out = wind_limits(r)
        if upper is None and lower is None:
            return "FIELD_CHECK", "wind clause the planner cannot read as a limit; check the label on site"
        if math.isnan(wind):
            return "FIELD_CHECK", "no wind in the forecast for this hour"
        if upper is not None and (wind > upper or (upper_out and wind == upper)):
            return "BLOCKED", f"forecast wind up to {wind:g} mph {'>' if wind > upper else '='} {upper:g} mph"
        if lower is not None and (wind < lower or (lower_out and wind == lower)):
            return "FIELD_CHECK", f"forecast wind {wind:g} mph {'<' if wind < lower else '='} {lower:g} mph: variable direction, inversion potential"
        return None
    if param == "temperature_inversion":
        if alt < 3 or (alt < 20 and (math.isnan(wind) or wind < 3)):
            w = "unknown" if math.isnan(wind) else f"{wind:g} mph"
            return "FIELD_CHECK", f"sun {alt:.0f} deg, wind {w}: inversion possible, confirm on site"
        return None
    if param in ("rain_free_hours", "rainfall_expected"):
        if not r["value"]:
            return "FIELD_CHECK", "rain clause without a number of hours; check the label"
        n = int(r["value"])
        pop = max_pop(periods[i : i + n + 1])
        if pop >= RAIN_EXPECTED_POP:
            return "BLOCKED", f"rain chance up to {pop}% within {n} h (rain expected = {RAIN_EXPECTED_POP}%+)"
        if pop >= RAIN_UNSURE_POP:
            return "FIELD_CHECK", f"rain chance up to {pop}% within {n} h"
        return None
    if param in TEMPERATURE:
        # The typing model is not consistent about which side of a temperature threshold a clause forbids, so a
        # MUST or MUST_NOT temperature clause whose named condition holds is a field check that quotes the clause,
        # never a silent pass and never a guessed block.
        why = temperature_condition(r, i, periods)
        if why:
            return "FIELD_CHECK", f"{why}: the label sets a requirement at this temperature"
        if r["value"] is None or r["op"] not in SYMBOL:
            return "FIELD_CHECK", "temperature clause the planner cannot read as a limit; check the label on site"
        return None
    return "FIELD_CHECK", f"{param} limit on the label; the planner does not evaluate it yet, check it on site"


def evaluate(rules: list[dict], periods: list[dict], lat: float, lon: float, hours: int) -> list[dict]:
    """Evaluate forecast hours for one tank whose products are defined by all supplied rules.

    The tank is the set of distinct products across the rules passed to evaluate. Rules from all three labels
    contribute to that set regardless of modality, so an advisory rule still establishes that its product is in
    the tank.
    """
    tank_products = {r["product"] for r in rules}
    out = []
    for i, p in enumerate(periods[:hours]):
        t = dt.datetime.fromisoformat(p["startTime"])
        wind = mph(p.get("windSpeed", ""))
        blocked, checks, advisories = [], [], []
        alt = sun_altitude(lat, lon, t)
        for r in rules:
            cite = {"product": r["product"], "rule": r["id"], "page": r["page"], "quote": r["quote"]}
            if r["modality"] == "ADVISORY":
                why = advisory(r, i, periods, wind)
                if why:
                    advisories.append({**cite, "why": why})
                continue
            verdict = gate(r, i, periods, wind, alt, tank_products)
            if verdict:
                (blocked if verdict[0] == "BLOCKED" else checks).append({**cite, "why": verdict[1]})
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
                "advisories": advisories,
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--point", default="tift")
    ap.add_argument("--tank", nargs="+", default=["5481-504", "264-700", "264-418"])
    ap.add_argument("--hours", type=int, default=48)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--rules", default=DEFAULT_RULES, help="compiled rule-set suffix in data/compiled/")
    a = ap.parse_args()
    meta = json.loads(CACHE.read_text(encoding="utf-8"))[a.point]
    rules, skipped = [], []
    for reg in a.tank:
        _, u, s = load_rules(reg, a.rules)
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
        adv = f" | +{len(h['advisories'])} advisory" if h["advisories"] else ""
        print(f"{h['start'][5:16]} {h['state']:11} {str(h['temp_f']):>3}F {h['wind']:>12} pop {str(h['pop']):>3}% sun {h['sun_alt']:>5} | {why}{adv}")
    permitted = sum(h["state"] == "PERMITTED" for h in hours)
    print(f"PERMITTED {permitted} / FIELD_CHECK {sum(h['state'] == 'FIELD_CHECK' for h in hours)} / BLOCKED {sum(h['state'] == 'BLOCKED' for h in hours)} of {len(hours)} hours")
    return 0


if __name__ == "__main__":
    sys.exit(main())
