"""Second checking pass: re-type every accepted rule from its quote alone, with explicit parameter definitions.

The first pass reads a whole page and sometimes picks the wrong parameter for a correct quote (a nurse-tank
sentence typed as night temperature, a 24-hour mean temperature typed as an inversion). This pass gives a
second Nemotron model only the quote and a definition for every parameter, under a strict JSON schema.
The compiler's number guard then runs again on the new values.

Output: data/compiled/<reg><suffix>.typed.json with the same shape as the input, plus for every rule
first_pass_param, typed_by and agreed (whether both passes chose the same parameter).

With --votes K the rule is typed K times. Identical requests at temperature 0 do not always return the same
modality (Folex's "use FOLEX 6 EC alone" below 60 F nights came back MUST in one run and ADVISORY in two), so
disagreements are resolved toward the safety side: if any vote says MUST or MUST_NOT, the rule stays acting,
because a missed limit can mark a forbidden hour as permitted. Every vote is kept on the rule.

Run: python compiler/retype.py 5481-504 264-700 264-418 [--model nvidia/Nemotron-3-Ultra-550b-a55b] [--suffix ""] [--votes 3]
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

from compile_label import BASE, PARAMS, PRICES, guard, norm, restore_units
from compile_label import OUT as COMPILED

DEFAULT_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b"
TYPING_VERSION = "v3"  # v2: limits vs conditional duties and educational text; v3: types the one constraint the first pass named

DEFINITIONS = {
    "wind_speed_mph": "a limit on the wind speed or gusts under which the product may be applied (not a duty that only applies at some wind speed)",
    "air_temperature_f": "a daytime, current or mean air temperature condition (not an inversion)",
    "night_temperature_f": "a nighttime or minimum night temperature condition",
    "rain_free_hours": "do not apply, or apply only, if rain is or is not expected within N hours of application",
    "rainfall_expected": "a statement that rain within N hours reduces performance (advice, not a prohibition)",
    "temperature_inversion": "a rule about applying during a temperature inversion or conditions that favor one (not a description of what inversions are)",
    "relative_humidity_pct": "a humidity condition",
    "droplet_size": "required or advised spray droplet size or quality",
    "boom_height_in": "height of a ground boom or nozzles above ground or canopy",
    "release_height_ft": "spray release height above ground or canopy, ground or aerial",
    "open_boll_pct": "percent of cotton bolls open when applying",
    "crop_stage": "any crop growth stage other than a percent of bolls open",
    "days_before_harvest": "minimum time between application and harvest, in days or hours (harvest can commence after N)",
    "application_interval_days": "minimum days between applications",
    "max_applications": "maximum number of applications",
    "rate_per_acre": "product rate per acre for one application, including rate-table rows that pick a rate by weather or crop condition",
    "max_rate_per_season": "maximum product per acre per season or year",
    "spray_volume_gal_per_acre": "spray volume in gallons per acre",
    "buffer_ft": "a minimum distance from a sensitive area, other crop, water or residence, in any unit (feet, miles)",
    "reentry_hours": "the restricted-entry interval (REI) before workers may enter treated areas, in hours or days",
    "grazing_restriction": "grazing or feeding restrictions",
    "irrigation_restriction": "application through irrigation systems",
    "tank_mix": "whether or how the product may be mixed with other products",
    "adjuvant": "adjuvants, oils or surfactants",
    "application_method": (
        "equipment or procedure other than height and droplets (aerial setup, boom length, nozzles, pressure, swath displacement), "
        "including duties that apply only at some wind speed"
    ),
    "aerial_restriction": "a restriction that applies only to aerial application and fits no other parameter",
    "ppe": "personal protective equipment",
    "sensitive_area": "a sensitive area named without a distance",
    "other": "anything else: cleaning, rinsing, storage, and educational statements that describe drift, weather or inversions without telling the applicator what to do",
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
    "You type one constraint from a U.S. EPA pesticide label clause. A clause can state several constraints "
    "(a height and a wind limit in one sentence): type only the CONSTRAINT TO TYPE, with the parameter whose definition fits it.\n"
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
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"CLAUSE: {rule['quote']}\nCONSTRAINT TO TYPE: {rule.get('summary') or 'the main constraint of the clause'}"},
        ],
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


ACTING = ("MUST", "MUST_NOT")


def vote(first_pass_param: str, typed: list[dict]) -> tuple[dict, dict]:
    """Combine K typings of one rule into one, and describe the agreement.

    Parameter: the most common choice; a tie goes to the first pass's parameter if it is among the tied, else to
    the earliest vote. Modality: among votes for that parameter, any MUST or MUST_NOT wins over ADVISORY (the most
    common acting one, then the earliest). The numbers come from the earliest vote with the chosen parameter and
    modality, so they are one model answer, never a blend.
    """
    params = [t["param"] for t in typed]
    top = max(params.count(x) for x in params)
    tied = [x for x in dict.fromkeys(params) if params.count(x) == top]
    param = first_pass_param if first_pass_param in tied else tied[0]
    same = [t for t in typed if t["param"] == param]
    mods = [t["modality"] for t in same]
    acting = [m for m in mods if m in ACTING]
    pool = acting or mods
    modality = max(dict.fromkeys(pool), key=pool.count)
    chosen = next(t for t in same if t["modality"] == modality)
    info = {"votes": [{"param": t["param"], "modality": t["modality"]} for t in typed], "unanimous": len({(t["param"], t["modality"]) for t in typed}) == 1}
    return chosen, info


def retype(reg: str, model: str, suffix: str, out_tag: str = "", votes: int = 1) -> dict:
    key = os.environ.get("NEBIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("NEBIUS_API_KEY missing")
    src = json.loads((COMPILED / f"{reg}{suffix}.json").read_text(encoding="utf-8"))
    jobs = [(n, k) for n in range(len(src["accepted"])) for k in range(votes)]
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        flat = list(ex.map(lambda job: call(model, src["accepted"][job[0]], key), jobs))
    results = [flat[n * votes : (n + 1) * votes] for n in range(len(src["accepted"]))]
    accepted, rejected, failed = [], list(src["rejected"]), 0
    tin = tout = split = 0
    for rule, rs in zip(src["accepted"], results, strict=True):
        for res in rs:
            tin += res["usage"].get("prompt_tokens", 0)
            tout += res["usage"].get("completion_tokens", 0)
        ok = [res["typed"] for res in rs if res["ok"]]
        if not ok:
            failed += 1
            accepted.append({**rule, "first_pass_param": rule["param"], "typed_by": None, "agreed": None})
            continue
        t, info = vote(rule["param"], ok)
        extra = {"typing_votes": info["votes"], "typing_unanimous": info["unanimous"]} if votes > 1 else {}
        split += 0 if info["unanimous"] else 1
        new = restore_units({**rule, **t, "first_pass_param": rule["param"], "typed_by": model, "agreed": t["param"] == rule["param"], **extra})
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
        "retype_votes": votes,
        "retype_split_votes": split,
        "retype_tokens_in": tin,
        "retype_tokens_out": tout,
        "retype_cost_usd": round(tin / 1e6 * price[0] + tout / 1e6 * price[1], 4),
        "accepted": accepted,
        "rejected": rejected,
    }
    tag = ("" if model == DEFAULT_MODEL else "." + model.split("/")[-1]) + out_tag
    out["typing_version"] = TYPING_VERSION
    (COMPILED / f"{reg}{suffix}.typed{tag}.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--suffix", default="")
    ap.add_argument("--tag", default="", help="appended to the output name, so typing versions can be compared side by side")
    ap.add_argument("--votes", type=int, default=1, help="type every rule this many times and resolve disagreement toward acting")
    a = ap.parse_args()
    for reg in a.regs:
        o = retype(reg, a.model, a.suffix, a.tag, a.votes)
        agreed = sum(1 for r in o["accepted"] if r.get("agreed"))
        tokens = f"tokens {o['retype_tokens_in']}/{o['retype_tokens_out']} ${o['retype_cost_usd']}"
        print(f"{reg}: retyped {len(o['accepted'])} agreed {agreed} split votes {o['retype_split_votes']} failed {o['retype_failed']} {tokens}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
