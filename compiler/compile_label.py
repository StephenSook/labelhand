"""Compile an EPA pesticide label PDF into typed, clause-cited rules with Nemotron on Nebius Token Factory.

Pipeline (one label):
  1. Extract text per page (pypdf). The page text is the only source of truth.
  2. For each page, Nemotron 3 Super returns rules under a strict JSON schema (guided decoding).
  3. Deterministic guards, in code, never in the model:
       QUOTE  the rule's quote must appear verbatim in that page (whitespace-normalised only).
       NUMBER every number in the rule's value fields must appear in its own quote.
     A rule failing a guard is kept in the output as REJECTED with the reason, never silently fixed.
  4. Write data/compiled/<reg>.json with rules, rejections, token usage, latency and cost.

Run: .venv/Scripts/python.exe compiler/compile_label.py 5481-504 [--model ...] [--thinking]
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

from pypdf import PdfReader

ROOT = pathlib.Path(__file__).resolve().parents[1]
INDEX = ROOT / "data" / "labels" / "index.json"
OUT = ROOT / "data" / "compiled"
BASE = "https://api.tokenfactory.nebius.com/v1"
DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"
# Published Token Factory prices, USD per 1M tokens (input, output), recorded 2026-10-04 from the recon.
PRICES = {
    "nvidia/nemotron-3-super-120b-a12b": (0.30, 0.90),
    "nvidia/Nemotron-3-Ultra-550b-a55b": (1.00, 3.00),
    "nvidia/Nemotron-3_5-Lightning": (0.06, 0.24),
}

PARAMS = [
    "wind_speed_mph",
    "air_temperature_f",
    "night_temperature_f",
    "rain_free_hours",
    "rainfall_expected",
    "temperature_inversion",
    "relative_humidity_pct",
    "droplet_size",
    "boom_height_in",
    "release_height_ft",
    "open_boll_pct",
    "days_before_harvest",
    "application_interval_days",
    "max_applications",
    "rate_per_acre",
    "max_rate_per_season",
    "spray_volume_gal_per_acre",
    "buffer_ft",
    "reentry_hours",
    "grazing_restriction",
    "irrigation_restriction",
    "tank_mix",
    "adjuvant",
    "application_method",
    "aerial_restriction",
    "ppe",
    "crop_stage",
    "sensitive_area",
    "other",
]
RULE = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["forecast_series", "solar_window", "geometry_buffer", "counter", "field_obligation"]},
        "modality": {"type": "string", "enum": ["MUST", "MUST_NOT", "ADVISORY"]},
        "param": {"type": "string", "enum": PARAMS},
        "op": {"type": "string", "enum": ["lt", "lte", "gt", "gte", "eq", "between", "none"]},
        "value": {"type": ["number", "null"]},
        "value2": {"type": ["number", "null"]},
        "unit": {"type": ["string", "null"]},
        "applies_to": {"type": "string"},
        "summary": {"type": "string"},
        "quote": {"type": "string"},
    },
    "required": ["kind", "modality", "param", "op", "value", "value2", "unit", "applies_to", "summary", "quote"],
    "additionalProperties": False,
}
SCHEMA = {"type": "object", "properties": {"rules": {"type": "array", "items": RULE}}, "required": ["rules"], "additionalProperties": False}

PROMPT_VERSION = "p2"  # p2: one rule per constraint or alternative, each quoting the whole sentence
SYSTEM = """You compile one page of a U.S. EPA pesticide label into machine-checkable rules for a spray-window planner.
Extract every restriction or requirement that decides WHEN, WHERE or HOW the product may be applied:
weather (wind, temperature, rain, inversion, humidity), timing and crop stage, rates and limits, intervals,
buffers and sensitive areas, application method and equipment, tank-mix permissions or prohibitions,
re-entry and grazing restrictions, and protective equipment.

Rules:
- "quote" must be copied character for character from the page text, one sentence or clause, no paraphrase.
  Never use "..." to join pieces; if a requirement spans two sentences, emit two rules.
- One rule per constraint. If one sentence states several constraints (a height and a wind limit) or alternatives
  (7 days at one rate, or 10 days at a higher rate), emit one rule for each, every one quoting the whole sentence,
  and say in "summary" which constraint or alternative that rule is.
- value and value2 are numbers exactly as written in the quote, in the quote's own unit. Never convert units
  (3 feet stays 3 with unit "feet"; one-half mile stays 0.5 with unit "mile" only if "1/2" or "0.5" is written).
  If the clause has no number, use null and op "none".
- modality MUST_NOT for prohibitions ("Do not ..."), MUST for requirements, ADVISORY for recommendations ("should", "best results").
- kind: forecast_series for weather conditions checked against a forecast, solar_window for time-of-day limits,
  geometry_buffer for distances, counter for counts, rates and intervals, field_obligation for anything the
  applicator must do or check in the field.
- applies_to: the crop, application type (ground, aerial) or situation the clause applies to, from the page.
- Skip first-aid, storage, disposal, container and marketing text. Skip anything not on this page.
- If the page has no such clauses, return {"rules": []}."""

NUM = re.compile(r"\d+(?:\.\d+)?")
FRACTION = re.compile(r"(\d+)\s*/\s*(\d+)")
# Source stays ASCII: label characters are written as code points.
VULGAR = {chr(0xBD): 0.5, chr(0xBC): 0.25, chr(0xBE): 0.75, chr(0x2153): 1 / 3, chr(0x2154): 2 / 3}
MIXED = re.compile(r"(\d+)\s*([" + "".join(VULGAR) + r"])")
UNREADABLE = chr(0xFFFD)  # what text extraction yields for a glyph with no Unicode map
_FOLD = str.maketrans(
    {
        chr(0xAD): "",  # soft hyphen
        chr(0x2018): "'",
        chr(0x2019): "'",
        chr(0x201C): '"',
        chr(0x201D): '"',
        chr(0x2013): "-",
        chr(0x2014): "-",  # en and em dash in label text fold to a hyphen
        chr(0xFB01): "fi",
        chr(0xFB02): "fl",
    }
)


def norm(s: str) -> str:
    s = s.translate(_FOLD)
    s = re.sub(r"-\s*\n\s*", "-", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def squash(s: str) -> str:
    """Drop all whitespace. PDF text layers split words ("t hidiazuron", "24 -hour"); an exact match on
    every non-space character is still exact, just blind to where the extractor put spaces."""
    return re.sub(r"\s+", "", s)


def guard(rule: dict, page_text_norm: str) -> str | None:
    q = norm(rule.get("quote", ""))
    if len(q) < 8:
        return "QUOTE_TOO_SHORT"
    if "..." in q or chr(0x2026) in q:
        return "QUOTE_SPLICED"  # an ellipsis joins two places on the page into one claim
    if q not in page_text_norm and squash(q) not in squash(page_text_norm):
        return "QUOTE_NOT_IN_PAGE"
    nums_in_quote = {num_str(n) for n in quote_numbers(q)}
    for key in ("value", "value2"):
        v = rule.get(key)
        if v is not None and num_str(float(v)) not in nums_in_quote:
            if UNREADABLE in q:
                # The PDF font has no Unicode map for a glyph (Folex 2026 prints "2 1/2" as "2" plus U+FFFD).
                # The number cannot be verified from text; it goes to a vision read of the rendered page.
                return f"UNREADABLE_GLYPH:{key}={v}"
            return f"NUMBER_NOT_IN_QUOTE:{key}={v}"
    return None


def num_str(f: float) -> str:
    """Canonical text for a number so 10, 10.0 and '10' compare equal."""
    return str(int(f)) if f.is_integer() else f"{f:g}"


# (words in the quote, units the model may have converted to, factor). Code, not the model, owns conversions.
CONVERSIONS = [
    (("mile",), ("feet", "foot", "ft"), 5280),
    (("feet", "foot", "ft"), ("inches", "inch", "in"), 12),
    (("hour",), ("minutes", "minute", "min"), 60),
    (("day",), ("hours", "hour", "hr"), 24),
]


def quote_numbers(q: str) -> list[float]:
    """Every number written in a normalised quote: plain, fractions (1/2) and mixed numbers (2 1/2 as a glyph)."""
    nums = [float(n) for n in NUM.findall(q)]
    nums += [int(a) / int(b) for a, b in FRACTION.findall(q) if int(b)]
    nums += [int(w) + VULGAR[f] for w, f in MIXED.findall(q)]
    return nums


def restore_units(rule: dict) -> dict:
    """Undo a unit conversion the model did on its own, when code can reproduce it exactly.

    The labels say "one-half (1/2) mile"; models tend to answer 2,640 feet. If a value equals a number in the
    quote times a known factor, and the quote names the source unit, the value goes back to the label's own
    number and unit, and the rule records what was undone. Anything code cannot reproduce is left for the
    number guard to reject.
    """
    q = norm(rule.get("quote", ""))
    unit = (rule.get("unit") or "").lower().strip()
    nums = quote_numbers(q)
    out = dict(rule)
    for key in ("value", "value2"):
        v = rule.get(key)
        if v is None or any(abs(float(v) - n) < 1e-9 for n in nums):
            continue
        for src_words, dst_units, factor in CONVERSIONS:
            if unit in dst_units and any(w in q for w in src_words):
                match = [n for n in nums if abs(n * factor - float(v)) < 1e-6]
                if match:
                    out[key] = match[0]
                    out["unit"] = src_words[0]
                    out["unit_restored"] = f"{num_str(float(v))} {unit} -> {num_str(match[0])} {src_words[0]} (model conversion undone in code)"
                    break
    return out


MAX_TOKENS = 6000


class Truncated(Exception):
    """The answer hit max_tokens. Strict JSON schema does not prevent this; the JSON is cut off mid-string."""


def _request(model: str, page_no: int, text: str, key: str, thinking: bool) -> tuple[list[dict], dict, str]:
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": f"PAGE {page_no} TEXT:\n{text}"}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "label_rules", "schema": SCHEMA, "strict": True}},
        "chat_template_kwargs": {"enable_thinking": thinking},
    }
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        out = json.load(r)
        rid = r.headers.get("x-request-id", "")
    choice = out["choices"][0]
    if choice.get("finish_reason") == "length":
        raise Truncated(f"finish_reason=length at {(out.get('usage') or {}).get('completion_tokens')} tokens")
    return json.loads(choice["message"]["content"]).get("rules", []), out.get("usage", {}), rid


def split_text(text: str) -> tuple[str, str]:
    """Split a page at the line break nearest its middle, so no sentence is cut in half by the split itself."""
    mid = len(text) // 2
    cut = text.rfind("\n", 0, mid)
    if cut < len(text) // 4:
        cut = text.find("\n", mid)
    if cut == -1:
        cut = mid
    return text[:cut], text[cut:]


def call(model: str, page_no: int, text: str, key: str, thinking: bool, depth: int = 0) -> dict:
    """Compile one page. A truncated answer is not retried as-is (it would truncate again): the page is split in
    two and each half is compiled, up to two levels deep. Guards still check quotes against the whole page."""
    t = time.time()
    err = ""
    for attempt in range(3):
        try:
            rules, usage, rid = _request(model, page_no, text, key, thinking)
            return {"page": page_no, "ok": True, "secs": round(time.time() - t, 2), "request_id": rid, "usage": usage, "rules": rules, "splits": depth}
        except Truncated as e:
            if depth >= 2:
                err = f"Truncated even after splitting: {e}"
                break
            halves = [call(model, page_no, part, key, thinking, depth + 1) for part in split_text(text)]
            usage = {k: sum((h.get("usage") or {}).get(k, 0) for h in halves) for k in ("prompt_tokens", "completion_tokens")}
            ok = all(h["ok"] for h in halves)
            return {
                "page": page_no,
                "ok": ok,
                "secs": round(time.time() - t, 2),
                "usage": usage,
                "rules": [r for h in halves for r in h["rules"]],
                "splits": max(h.get("splits", 0) for h in halves),
                **({} if ok else {"error": "; ".join(h.get("error", "") for h in halves if not h["ok"])}),
            }
        except urllib.error.HTTPError as e:
            err = f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"
            if e.code in (402, 400, 401, 403):
                break  # not retryable: out of credit, bad request, bad key
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
        time.sleep(2 + 4 * attempt)
    return {"page": page_no, "ok": False, "secs": round(time.time() - t, 2), "error": err, "rules": []}


def compile_label(reg: str, model: str, thinking: bool, tag: str = "") -> dict:
    key = os.environ.get("NEBIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("NEBIUS_API_KEY missing")
    meta = json.loads(INDEX.read_text(encoding="utf-8"))[reg]
    pages = [p.extract_text() or "" for p in PdfReader(ROOT / meta["file"]).pages]
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(lambda ip: call(model, ip[0] + 1, ip[1], key, thinking), enumerate(pages)))
    accepted, rejected, failed_pages = [], [], []
    tin = tout = 0
    for res in results:
        u = res.get("usage") or {}
        tin += u.get("prompt_tokens", 0)
        tout += u.get("completion_tokens", 0)
        if not res["ok"]:
            failed_pages.append({"page": res["page"], "error": res["error"]})
            continue
        pn = norm(pages[res["page"] - 1])
        for i, r in enumerate(res["rules"]):
            r = restore_units({**r, "page": res["page"], "id": f"{reg}-p{res['page']}-{i + 1}"})
            why = guard(r, pn)
            (rejected if why else accepted).append({**r, "reject_reason": why} if why else r)
    price = PRICES.get(model, (0, 0))
    report = {
        "reg": reg,
        "product": meta["product"],
        "label_accepted": meta["accepted"],
        "label_sha256": meta["sha256"],
        "label_url": meta["url"],
        "model": model,
        "thinking": thinking,
        "prompt_version": PROMPT_VERSION,
        "compiled_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "pages": len(pages),
        "failed_pages": failed_pages,
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_usd": round(tin / 1e6 * price[0] + tout / 1e6 * price[1], 4),
        "wall_secs_max_page": max((r["secs"] for r in results), default=0),
        "accepted": accepted,
        "rejected": rejected,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    suffix = ("" if model == DEFAULT_MODEL else "." + model.split("/")[-1]) + (".thinking" if thinking else "") + tag
    (OUT / f"{reg}{suffix}.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--thinking", action="store_true")
    ap.add_argument("--tag", default="", help="appended to the output name, so prompt versions can be compared side by side")
    a = ap.parse_args()
    bad = 0
    for reg in a.regs:
        r = compile_label(reg, a.model, a.thinking, a.tag)
        n_acc, n_rej = len(r["accepted"]), len(r["rejected"])
        reasons: dict[str, int] = {}
        for x in r["rejected"]:
            k = x["reject_reason"].split(":")[0]
            reasons[k] = reasons.get(k, 0) + 1
        print(
            f"{reg} {r['product'].encode('ascii', 'replace').decode()} | pages {r['pages']} failed {len(r['failed_pages'])} | "
            f"accepted {n_acc} rejected {n_rej} {reasons} | tokens {r['tokens_in']}/{r['tokens_out']} ${r['cost_usd']} | slowest page {r['wall_secs_max_page']}s"
        )
        bad += 1 if r["failed_pages"] else 0
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
