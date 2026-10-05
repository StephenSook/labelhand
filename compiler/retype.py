"""Second checking pass: re-type every accepted rule from its quote alone, with explicit parameter definitions.

The first pass reads a whole page and sometimes picks the wrong parameter for a correct quote (a nurse-tank
sentence typed as night temperature, a 24-hour mean temperature typed as an inversion). This pass gives a
second Nemotron model only the quote and a definition for every parameter, under a strict JSON schema.
The compiler's number guard then runs again on the new values.

Output: data/compiled/<reg><suffix>.typed.json with the same shape as the input, plus for every rule
first_pass_param, typed_by and agreed (whether both passes chose the same parameter).

Run: python compiler/retype.py 5481-504 264-700 264-418 [--model nvidia/Nemotron-3-Ultra-550b-a55b] [--suffix ""]
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

from compile_label import BASE, PARAMS, PRICES, guard, norm
from compile_label import OUT as COMPILED

DEFAULT_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b"

DEFINITIONS = {
    "wind_speed_mph": "a limit or condition on wind speed or gusts at application time",
    "air_temperature_f": "a daytime, current or mean air temperature condition (not an inversion)",
    "night_temperature_f": "a nighttime or minimum night temperature condition",
    "rain_free_hours": "do not apply, or apply only, if rain is or is not expected within N hours of application",
    "rainfall_expected": "a statement that rain within N hours reduces performance (advice, not a prohibition)",
    "temperature_inversion": "applying during a temperature inversion, or conditions that favor one",
    "relative_humidity_pct": "a humidity condition",
    "droplet_size": "required or advised spray droplet size or quality",
    "boom_height_in": "height of a ground boom or nozzles above ground or canopy",
    "release_height_ft": "spray release height above ground or canopy, ground or aerial",
    "open_boll_pct": "percent of cotton bolls open when applying",
    "crop_stage": "any crop growth stage other than a percent of bolls open",
    "days_before_harvest": "minimum days between application and harvest",
    "application_interval_days": "minimum days between applications",
    "max_applications": "maximum number of applications",
    "rate_per_acre": "product rate per acre for one application",
    "max_rate_per_season": "maximum product per acre per season or year",
    "spray_volume_gal_per_acre": "spray volume in gallons per acre",
    "buffer_ft": "a minimum distance from a sensitive area, crop, water or residence",
    "reentry_hours": "the restricted-entry interval (REI) before workers may enter treated areas, in hours or days",
    "grazing_restriction": "grazing or feeding restrictions",
    "irrigation_restriction": "application through irrigation systems",
    "tank_mix": "whether or how the product may be mixed with other products",
    "adjuvant": "adjuvants, oils or surfactants",
    "application_method": "application equipment or method other than height and droplets (aerial setup, nozzles, pressure, swath)",
    "aerial_restriction": "a restriction that applies only to aerial application and fits no other parameter",
    "ppe": "personal protective equipment",
    "sensitive_area": "a sensitive area named without a distance",
    "other": "anything else, including cleaning, rinsing, storage and general statements",
}
SCHEMA = {
    "type": "object",
    "properties": {
        "param": {"type": "string", "enum": PARAMS},
        "op": {"type": "string", "enum": ["lt", "lte", "gt", "gte", "eq", "between", "none"]},
        "value": {"type": ["number", "null"]},
        "value2": {"type": ["number", "null"]},
        "unit": {"type": ["string", "null"]},
        "modality": {"type": "string", "enum": ["MUST", "MUST_NOT", "ADVISORY"]},
    },
    "required": ["param", "op", "value", "value2", "unit", "modality"],
    "additionalProperties": False,
}
SYSTEM = (
    "You type one clause from a U.S. EPA pesticide label. Choose the single parameter whose definition fits the clause best.\n"
    + "\n".join(f"- {k}: {v}" for k, v in DEFINITIONS.items())
    + "\nvalue and value2 are numbers exactly as written in the clause, in the clause's own unit; never convert units. "
    "Use null and op none when the clause states no number. modality: MUST_NOT for prohibitions (do not, must not), "
    "MUST for requirements (must, apply only when, required), ADVISORY for recommendations and statements of effect "
    "(should, avoid, is recommended, may reduce, best results)."
)


def call(model: str, rule: dict, key: str) -> dict:
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": 400,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": f"CLAUSE: {rule['quote']}"}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "typed_rule", "schema": SCHEMA, "strict": True}},
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    err = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.load(r)
            return {"ok": True, "typed": json.loads(out["choices"][0]["message"]["content"]), "usage": out.get("usage", {})}
        except urllib.error.HTTPError as e:
            err = f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"
            if e.code in (400, 401, 402, 403):
                break
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
        time.sleep(2 + 3 * attempt)
    return {"ok": False, "error": err, "usage": {}}


def retype(reg: str, model: str, suffix: str) -> dict:
    key = os.environ.get("NEBIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("NEBIUS_API_KEY missing")
    src = json.loads((COMPILED / f"{reg}{suffix}.json").read_text(encoding="utf-8"))
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(lambda r: call(model, r, key), src["accepted"]))
    accepted, rejected, failed = [], list(src["rejected"]), 0
    tin = tout = 0
    for rule, res in zip(src["accepted"], results, strict=True):
        tin += res["usage"].get("prompt_tokens", 0)
        tout += res["usage"].get("completion_tokens", 0)
        if not res["ok"]:
            failed += 1
            accepted.append({**rule, "first_pass_param": rule["param"], "typed_by": None, "agreed": None})
            continue
        t = res["typed"]
        new = {**rule, **t, "first_pass_param": rule["param"], "typed_by": model, "agreed": t["param"] == rule["param"]}
        why = guard(new, norm(rule["quote"]))  # the quote is its own page here: only the number guard can fail
        if why:
            # The re-typed numbers are not in the quote. The first pass already passed every guard, so keep it
            # unchanged and record that the second opinion was unusable, instead of losing a correct clause.
            accepted.append({**rule, "first_pass_param": rule["param"], "typed_by": model, "agreed": None, "retype_rejected": why})
        else:
            accepted.append(new)
    price = PRICES.get(model, (0, 0))
    out = {
        **{k: v for k, v in src.items() if k not in ("accepted", "rejected")},
        "retyped_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "retype_model": model,
        "retype_failed": failed,
        "retype_tokens_in": tin,
        "retype_tokens_out": tout,
        "retype_cost_usd": round(tin / 1e6 * price[0] + tout / 1e6 * price[1], 4),
        "accepted": accepted,
        "rejected": rejected,
    }
    tag = "" if model == DEFAULT_MODEL else "." + model.split("/")[-1]
    (COMPILED / f"{reg}{suffix}.typed{tag}.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--suffix", default="")
    a = ap.parse_args()
    for reg in a.regs:
        o = retype(reg, a.model, a.suffix)
        agreed = sum(1 for r in o["accepted"] if r.get("agreed"))
        print(f"{reg}: retyped {len(o['accepted'])} agreed {agreed} failed {o['retype_failed']} tokens {o['retype_tokens_in']}/{o['retype_tokens_out']} ${o['retype_cost_usd']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
