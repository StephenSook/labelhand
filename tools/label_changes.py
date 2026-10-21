"""Export what changed between each shipped label and the version EPA accepted before it, for the web /changes page.

Built from committed files only (the label PDFs stay out of git):

  rules   the shipped `.ship` rules against the earlier version's `.ship` rules (data/compiled/previous, compiled once
          by tools/previous_compile.py with the shipped pipeline), matched by sentence: rules added, removed, and
          changed (parameter, operator, value, unit or modality)
  hours   the planner kernel (engine/windows.py) on each committed replay forecast (tests/fixtures/engine/<point>.json),
          once with the shipped rules and once with this label's earlier rules: every hour whose state changes, for the
          shipped tank and for the product alone

Two compiles of the same sentence can differ: the merged rule count of one label moved by a third between two runs.
So every added or removed rule says whether its sentence is printed in the other version at all. A rule whose
sentence is in both labels is a difference between two compiles, not a change on the label. That fact comes from
LABEL_TEXT, which `--text-check` writes from the two PDFs with the compiler's own text extraction and normalization,
and records each PDF's SHA-256 so the check is tied to the exact files the rules were compiled from.

Run: python tools/label_changes.py --text-check   (needs both PDFs in data/labels; see tools/previous_compile.py)
     python tools/label_changes.py [--check]
"""

from __future__ import annotations

import argparse
import contextlib
import json
import pathlib
import re
import sys
from collections import Counter
from collections.abc import Iterator
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))
sys.path.insert(0, str(ROOT / "engine"))
import windows  # noqa: E402
from compile_label import norm, num_str, squash  # noqa: E402

SHIPPED_DIR = ROOT / "data" / "compiled"
PREVIOUS_DIR = SHIPPED_DIR / "previous"
LABELS = ROOT / "data" / "labels" / "index.json"
PREVIOUS_INDEX = PREVIOUS_DIR / "index.json"
COMPILE_RECEIPT = ROOT / "eval" / "results" / "previous-compile-2026-10-21.json"
LABEL_TEXT = ROOT / "eval" / "results" / "label-changes-text-2026-10-21.json"
FIXTURES = ROOT / "tests" / "fixtures" / "engine"
OUT = ROOT / "web" / "public" / "data" / "changes.json"
TANK = ["5481-504", "228-653", "228-659"]
# Every committed forecast the engine fixtures freeze: the three Oct 5 replays the app serves, and the cold Tift
# forecast recorded Oct 19 (52 of 80 night hours below 60 F), the only one that meets the labels' night-temperature
# conditions.
FORECASTS = {"tift": "tift.json", "worth": "worth.json", "colquitt": "colquitt.json", "tift-cold": "tift-cold-full-tank.json"}
HOURS = 156
COMPARED = ("op", "value", "value2", "unit", "modality")
ACTING = ("MUST", "MUST_NOT")
# Parameters the page surfaces first: the weather limits the planner reads, and the spray conditions an applicator
# checks in the field.
SPRAY_CONDITIONS = set(windows.TOPIC) | {"buffer_ft", "droplet_size", "release_height_ft", "boom_height_in", "reentry_hours"}


def quote_key(quote: str) -> str:
    """The sentence identity compiler/merge_runs.py and engine/windows.py use: lowercase, word characters only."""
    return re.sub(r"\W+", "", quote.lower())


def text_key(text: str) -> str:
    """How a quote is looked for in a label's text: the compiler's normalization, then letters and digits only, the
    same identity quote_key gives a rule. A dash one PDF's text layer drops ("1.6  6.4" for "1.6 - 6.4") is not a
    change in wording."""
    return re.sub(r"\W+", "", squash(norm(text)))


def read(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def same(field: str, a: Any, b: Any) -> bool:
    if field in ("value", "value2"):
        if a is None or b is None:
            return a is b
        return num_str(float(a)) == num_str(float(b))
    if field == "unit":
        return (a or "").strip().lower() == (b or "").strip().lower()
    return a == b


def planner_role(rule: dict[str, Any]) -> str:
    """'acting' when the rule can block or flag an hour, 'advisory' when the planner reports it, else 'not read'."""
    words = windows.TOPIC.get(rule["param"])
    if not words or not all(word in rule["quote"].lower() for word in words) or windows.other_crop(rule):
        return "not read"
    return "acting" if rule["modality"] in ACTING else "advisory"


def view(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": rule["id"],
        "page": rule["page"],
        "param": rule["param"],
        "op": rule.get("op"),
        "value": rule.get("value"),
        "value2": rule.get("value2"),
        "unit": rule.get("unit"),
        "modality": rule["modality"],
        "quote": rule["quote"],
        "planner": planner_role(rule),
        "spray_condition": rule["param"] in SPRAY_CONDITIONS,
    }


def rule_diff(shipped: list[dict[str, Any]], previous: list[dict[str, Any]]) -> dict[str, Any]:
    """Match two rule sets by sentence, then by parameter. Returns added, removed, changed and the unchanged count."""

    def by_sentence(rules: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
        out: dict[str, dict[str, dict[str, Any]]] = {}
        for rule in rules:
            out.setdefault(quote_key(rule["quote"]), {}).setdefault(rule["param"], rule)
        return out

    new, old = by_sentence(shipped), by_sentence(previous)
    added, removed, changed, unchanged = [], [], [], 0
    for key in sorted(new.keys() | old.keys()):
        now, before = new.get(key, {}), old.get(key, {})
        for param in sorted(now.keys() & before.keys()):
            fields = [f for f in COMPARED if not same(f, now[param].get(f), before[param].get(f))]
            if fields:
                changed.append({"key": key, "fields": fields, "shipped": view(now[param]), "previous": view(before[param])})
            else:
                unchanged += 1
        only_now = sorted(now.keys() - before.keys())
        only_before = sorted(before.keys() - now.keys())
        if len(only_now) == 1 and len(only_before) == 1:
            p_now, p_before = only_now[0], only_before[0]
            fields = ["param", *(f for f in COMPARED if not same(f, now[p_now].get(f), before[p_before].get(f)))]
            changed.append({"key": key, "fields": fields, "shipped": view(now[p_now]), "previous": view(before[p_before])})
            continue
        added += [{"key": key, "shipped": view(now[param])} for param in only_now]
        removed += [{"key": key, "previous": view(before[param])} for param in only_before]
    return {"added": added, "removed": removed, "changed": changed, "unchanged": unchanged}


@contextlib.contextmanager
def compiled_dir(path: pathlib.Path) -> Iterator[None]:
    saved = windows.COMPILED
    windows.COMPILED = path
    try:
        yield
    finally:
        windows.COMPILED = saved


def planner_rules(reg: str, folder: pathlib.Path) -> list[dict[str, Any]]:
    with compiled_dir(folder):
        return windows.load_rules(reg)[1]


def cited(hour: dict[str, Any]) -> set[str]:
    return {quote_key(c["quote"]) for c in hour["blocked"] + hour["checks"]}


def hours_moved(shipped_rules: list[dict[str, Any]], previous_rules: list[dict[str, Any]], fixture: dict[str, Any]) -> dict[str, Any]:
    """Every forecast hour whose state differs between two rule sets on one committed forecast."""
    lat, lon, periods = fixture["lat"], fixture["lon"], fixture["periods"]
    now = windows.evaluate(shipped_rules, periods, lat, lon, HOURS)
    before = windows.evaluate(previous_rules, periods, lat, lon, HOURS)
    moved = []
    # Clauses that block or flag an hour under one rule set only, counted over every hour, so a clause that changes
    # no state (the hour was blocked anyway) is still reported.
    only_shipped: Counter[str] = Counter()
    only_previous: Counter[str] = Counter()
    for a, b in zip(now, before, strict=True):
        only_shipped.update(cited(a) - cited(b))
        only_previous.update(cited(b) - cited(a))
        if a["state"] == b["state"]:
            continue
        moved.append(
            {
                "start": a["start"],
                "shipped": a["state"],
                "previous": b["state"],
                # The clauses that block or flag the hour under one rule set and not the other.
                "only_shipped": sorted(cited(a) - cited(b)),
                "only_previous": sorted(cited(b) - cited(a)),
            }
        )
    return {
        "hours": len(now),
        "changed": len(moved),
        "transitions": dict(sorted(Counter(f"{m['previous']}->{m['shipped']}" for m in moved).items())),
        "states_shipped": dict(sorted(Counter(h["state"] for h in now).items())),
        "states_previous": dict(sorted(Counter(h["state"] for h in before).items())),
        "moved": moved,
        "hours_citing_only_shipped": dict(sorted(only_shipped.items())),
        "hours_citing_only_previous": dict(sorted(only_previous.items())),
    }


def label_text(path: pathlib.Path) -> str:
    from pypdf import PdfReader

    return " ".join(page.extract_text() or "" for page in PdfReader(path).pages)


def text_check() -> dict[str, Any]:
    """For every sentence one compile has and the other lacks, whether each label's text prints it (needs the PDFs)."""
    import hashlib

    labels, previous = read(LABELS), read(PREVIOUS_INDEX)
    out: dict[str, Any] = {"normalization": "compiler/compile_label.py norm() then squash(), over the pypdf text of all pages", "labels": {}}
    for reg in TANK:
        if not (PREVIOUS_DIR / f"{reg}.ship.json").exists():
            continue
        files = {"shipped": ROOT / labels[reg]["file"], "previous": ROOT / previous[reg]["file"]}
        sha = {side: hashlib.sha256(path.read_bytes()).hexdigest() for side, path in files.items()}
        if sha["shipped"] != labels[reg]["sha256"] or sha["previous"] != previous[reg]["sha256"]:
            raise SystemExit(f"{reg}: a label PDF on disk is not the one the rules were compiled from")
        text = {side: text_key(label_text(path)) for side, path in files.items()}
        diff = rule_diff(read(SHIPPED_DIR / f"{reg}.ship.json")["accepted"], read(PREVIOUS_DIR / f"{reg}.ship.json")["accepted"])
        quotes = {}
        for entry in diff["added"] + diff["removed"]:
            rule = entry.get("shipped") or entry["previous"]
            key = text_key(rule["quote"])
            quotes[entry["key"]] = {"in_shipped": key in text["shipped"], "in_previous": key in text["previous"]}
        out["labels"][reg] = {"shipped_sha256": sha["shipped"], "previous_sha256": sha["previous"], "quotes": dict(sorted(quotes.items()))}
    return out


def build() -> dict[str, Any]:
    labels, receipt = read(LABELS), read(COMPILE_RECEIPT)
    previous_index = read(PREVIOUS_INDEX) if PREVIOUS_INDEX.exists() else {}
    text = read(LABEL_TEXT)["labels"] if LABEL_TEXT.exists() else {}
    fixtures = {name: read(FIXTURES / file) for name, file in FORECASTS.items()}
    shipped_planner = {reg: planner_rules(reg, SHIPPED_DIR) for reg in TANK}
    out: dict[str, Any] = {
        "sources": {
            "shipped_rules": "data/compiled/<reg>.ship.json",
            "previous_rules": "data/compiled/previous/<reg>.ship.json",
            "compile_receipt": COMPILE_RECEIPT.relative_to(ROOT).as_posix(),
            "label_text_check": LABEL_TEXT.relative_to(ROOT).as_posix(),
            "planner": "engine/windows.py",
        },
        "forecasts": {
            name: {
                "file": f"tests/fixtures/engine/{FORECASTS[name]}",
                "point": f["point"],
                "forecast_fetched_utc": f["forecast_fetched_utc"],
                "hours": min(HOURS, len(f["periods"])),
            }
            for name, f in fixtures.items()
        },
        "labels": {},
    }
    for reg in TANK:
        label = labels[reg]
        compiled = receipt["labels"][reg]
        entry: dict[str, Any] = {
            "product": label["product"],
            "shortName": label["shortName"],
            "shipped": {"accepted": label["accepted"], "url": label["url"], "sha256": label["sha256"]},
            "previous": {k: compiled[k] for k in ("accepted", "url", "sha256", "pages") if k in compiled},
            "versions_listed": compiled["versions_listed"],
            "compiled": compiled["compiled"],
        }
        if not compiled["compiled"]:
            entry["why_not_compiled"] = compiled["why"]
            out["labels"][reg] = entry
            continue
        assert previous_index[reg]["sha256"] == compiled["sha256"], reg
        shipped_rules = read(SHIPPED_DIR / f"{reg}.ship.json")["accepted"]
        previous_report = read(PREVIOUS_DIR / f"{reg}.ship.json")
        assert previous_report["label_sha256"] == compiled["sha256"], f"{reg}: earlier rules were compiled from another PDF"
        diff = rule_diff(shipped_rules, previous_report["accepted"])
        check = text.get(reg)
        if not check or check["shipped_sha256"] != label["sha256"] or check["previous_sha256"] != compiled["sha256"]:
            raise SystemExit(f"{reg}: {LABEL_TEXT.relative_to(ROOT)} does not cover these PDFs; run python tools/label_changes.py --text-check")
        for item in diff["added"] + diff["removed"]:
            found = check["quotes"].get(item["key"])
            if found is None:
                raise SystemExit(f"{reg}: no text check for one sentence; run python tools/label_changes.py --text-check")
            # Only a sentence that one label prints and the other does not is a change on the label.
            item["label_changed"] = found["in_shipped"] != found["in_previous"]
        for item in diff["changed"]:
            # Both compiles quote this sentence, and each quote passed the guard on its own label, so both labels print
            # it: what differs is how the two compiles typed it.
            item["label_changed"] = False
        previous_planner = planner_rules(reg, PREVIOUS_DIR)
        others = [r for other in TANK if other != reg for r in shipped_planner[other]]
        entry["rules"] = {
            "shipped_count": len(shipped_rules),
            "previous_count": len(previous_report["accepted"]),
            "shipped_planner": len(shipped_planner[reg]),
            "previous_planner": len(previous_planner),
            **diff,
        }
        entry["compile_cost_usd"] = compiled["cost_usd"]
        entry["hours"] = {
            point: {
                "tank": hours_moved(others + shipped_planner[reg], others + previous_planner, fixture),
                "alone": hours_moved(shipped_planner[reg], previous_planner, fixture),
            }
            for point, fixture in fixtures.items()
        }
        out["labels"][reg] = entry
    out["compile_cost_usd"] = receipt["total_cost_usd"]
    return out


def render(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed file differs")
    parser.add_argument("--text-check", action="store_true", help=f"rewrite {LABEL_TEXT.relative_to(ROOT)} from the label PDFs first")
    args = parser.parse_args()
    if args.text_check:
        LABEL_TEXT.write_text(json.dumps(text_check(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {LABEL_TEXT.relative_to(ROOT)}")
    text = render(build())
    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if current != text:
            print(f"{OUT.relative_to(ROOT)} is stale; run python tools/label_changes.py", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8", newline="\n")
    data = json.loads(text)
    for reg, entry in data["labels"].items():
        if not entry["compiled"]:
            print(f"{reg}: earlier version {entry['previous'].get('accepted')} not compiled: {entry['why_not_compiled']}")
            continue
        rules = entry["rules"]
        moved = {point: (h["tank"]["changed"], h["alone"]["changed"]) for point, h in entry["hours"].items()}
        print(
            f"{reg}: rules +{len(rules['added'])} -{len(rules['removed'])} ~{len(rules['changed'])} ={rules['unchanged']}"
            f" (label changed: +{sum(a['label_changed'] for a in rules['added'])} -{sum(r['label_changed'] for r in rules['removed'])})"
            f" | hours moved (tank, alone) {moved}"
        )
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
