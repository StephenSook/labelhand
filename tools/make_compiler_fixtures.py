"""Generate small Python-to-TypeScript compiler parity fixtures.

The source records contain rules produced from five EPA labels. Only selected
quotes and short page snippets are committed. Label PDFs and full extracted page
text remain outside the repository.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))

import compile_label  # noqa: E402
import modality  # noqa: E402
import retype  # noqa: E402

OUTPUT = ROOT / "web" / "tests" / "fixtures" / "compiler"


def read_rules(path: pathlib.Path) -> list[dict]:
    record = json.loads(path.read_text(encoding="utf-8"))
    return list(record.get("accepted", [])) + list(record.get("rejected", []))


def find_rule(rules: list[dict], needle: str) -> dict:
    matches = [rule for rule in rules if needle.lower() in rule.get("quote", "").lower()]
    if not matches:
        raise ValueError(f"No rule quote contains {needle!r}")
    return min(matches, key=lambda rule: len(rule["quote"]))


def small_rule(rule: dict) -> dict:
    return {key: rule.get(key) for key in ("quote", "value", "value2", "unit")}


def typing(rule: dict, *, param: str | None = None, modality_: str | None = None, value: float | None = None) -> dict:
    return {
        "param": param or rule["param"],
        "op": rule["op"],
        "value": rule.get("value") if value is None else value,
        "value2": rule.get("value2"),
        "unit": rule.get("unit"),
        "modality": modality_ or rule["modality"],
    }


def guard_case(name: str, source: str, rule: dict, page_text: str) -> dict:
    return {
        "name": name,
        "source": source,
        "input": {"rule": rule, "page_text": page_text},
        "expected": compile_label.guard(rule, compile_label.norm(page_text)),
    }


def build_fixtures(spike_root: pathlib.Path) -> dict[str, list[dict]]:
    sources = {
        "Folex 6 EC 5481-504": read_rules(ROOT / "web/public/data/compiled/5481-504.ship.json"),
        "Dropp SC 264-700": read_rules(ROOT / "web/public/data/compiled/264-700.ship.json"),
        "Prep 264-418": read_rules(ROOT / "web/public/data/compiled/264-418.ship.json"),
        "Osprey 264-802": read_rules(spike_root / "runs/design/264-802.first.json"),
        "Axial XL 100-1256": read_rules(spike_root / "runs/axial/100-1256.first.json"),
    }

    folex = sources["Folex 6 EC 5481-504"]
    dropp = sources["Dropp SC 264-700"]
    prep = sources["Prep 264-418"]
    osprey = sources["Osprey 264-802"]
    axial = sources["Axial XL 100-1256"]

    axial_wind = find_rule(axial, "wind speeds exceed 15 mph")
    dropp_wind = find_rule(dropp, "wind speeds exceed ten (10)")
    osprey_gust = find_rule(osprey, "GUSTY WIND CONDITIONS")
    prep_gust = find_rule(prep, "GUSTY WIND CONDITIONS")
    folex_mixed = find_rule(folex, "Do not exceed 2 ½ pints")

    guards = [
        guard_case("valid_axial_wind", "Axial XL 100-1256", small_rule(axial_wind), axial_wind["quote"]),
        guard_case(
            "quote_too_short",
            "Axial XL 100-1256",
            {"quote": axial_wind["quote"][:6], "value": None, "value2": None},
            axial_wind["quote"],
        ),
        guard_case(
            "quote_spliced",
            "Osprey 264-802",
            {"quote": f"{osprey_gust['quote']} ... Do not apply.", "value": None, "value2": None},
            osprey_gust["quote"],
        ),
        guard_case("quote_not_in_page", "Dropp SC 264-700", small_rule(dropp_wind), prep_gust["quote"]),
        guard_case(
            "number_not_in_quote",
            "Axial XL 100-1256",
            {**small_rule(axial_wind), "value": 12},
            axial_wind["quote"],
        ),
    ]
    unreadable = folex_mixed["quote"].replace("½", chr(0xFFFD))
    guards.append(
        guard_case(
            "unreadable_glyph",
            "Folex 6 EC 5481-504",
            {"quote": unreadable, "value": 2.5, "value2": None, "unit": "pints"},
            unreadable,
        )
    )

    restore_specs = [
        ("Folex 6 EC 5481-504", find_rule(folex, "no more than 4 feet above"), 48, "in"),
        ("Dropp SC 264-700", find_rule(dropp, "by air within one-half (1/2) mile of lettuce"), 2640, "ft"),
        ("Prep 264-418", find_rule(prep, "no more than 3 feet above"), 36, "in"),
    ]
    restore_units = []
    for source, rule, value, unit in restore_specs:
        input_rule = {**small_rule(rule), "value": value, "unit": unit}
        restore_units.append(
            {
                "name": source.split()[0].lower(),
                "source": source,
                "input": input_rule,
                "expected": compile_label.restore_units(input_rule),
            }
        )

    number_specs = [
        ("Folex 6 EC 5481-504", folex_mixed["quote"]),
        ("Dropp SC 264-700", find_rule(dropp, "one-half (1/2) mile of lettuce")["quote"]),
        ("Prep 264-418", find_rule(prep, "Add 1/2 to 3/4")["quote"]),
        ("Osprey 264-802", find_rule(osprey, "wind speeds exceed 10 miles")["quote"]),
        ("Axial XL 100-1256", axial_wind["quote"]),
    ]
    quote_numbers = [
        {
            "name": source.split()[0].lower(),
            "source": source,
            "input": quote,
            "expected": compile_label.quote_numbers(compile_label.norm(quote)),
        }
        for source, quote in number_specs
    ]

    folex_night = find_rule(folex, "minimum night temperature is below 60")
    prep_vote_rule = prep_gust
    osprey_rain = find_rule(osprey, "rain is not predicted for the next 24 hours")
    axial_swath = find_rule(axial, "applicators must use ½ swath displacement")
    vote_specs = [
        (
            "acting_wins",
            "Folex 6 EC 5481-504",
            folex_night["param"],
            [typing(folex_night, modality_="ADVISORY"), typing(folex_night, modality_="MUST"), typing(folex_night, modality_="ADVISORY")],
        ),
        (
            "majority_parameter",
            "Dropp SC 264-700",
            dropp_wind["param"],
            [typing(dropp_wind), typing(dropp_wind), typing(dropp_wind, param="other")],
        ),
        (
            "tie_keeps_first_pass",
            "Prep 264-418",
            "rain_free_hours",
            [typing(prep_vote_rule, param="rainfall_expected"), typing(prep_vote_rule, param="rain_free_hours")],
        ),
        ("single_osprey", "Osprey 264-802", osprey_rain["param"], [typing(osprey_rain)]),
        ("single_axial", "Axial XL 100-1256", axial_swath["param"], [typing(axial_swath)]),
    ]
    votes = []
    for name, source, first_pass, answers in vote_specs:
        chosen, info = retype.vote(first_pass, answers)
        votes.append(
            {
                "name": name,
                "source": source,
                "input": {"first_pass_param": first_pass, "typed": answers},
                "expected": {"chosen": chosen, "info": info},
            }
        )

    floor_specs = [
        ("folex_directive", "Folex 6 EC 5481-504", folex_night["quote"], "folex"),
        ("dropp_prohibition", "Dropp SC 264-700", dropp_wind["quote"], "dropp"),
        ("prep_avoid", "Prep 264-418", prep_gust["quote"], "prep"),
        ("osprey_prohibition", "Osprey 264-802", find_rule(osprey, "wind causes drift to off-site")["quote"], "osprey"),
        ("axial_technique", "Axial XL 100-1256", axial_swath["quote"], "axial"),
    ]
    floor_of = [
        {
            "name": name,
            "source": source,
            "input": {"quote": quote, "brand": brand},
            "expected": modality.floor_of(quote, brand),
        }
        for name, source, quote, brand in floor_specs
    ]

    advisory_specs = [
        (
            "folex_outside_advisory",
            "Folex 6 EC 5481-504",
            [f"SPRAY DRIFT ADVISORIES\nWIND\n{prep_gust['quote']}\nDEFOLIATION AND BOLL OPENING\n{folex_night['quote']}"],
            folex_night["quote"],
        ),
        (
            "dropp_mandatory_section",
            "Dropp SC 264-700",
            [f"MANDATORY SPRAY DRIFT MANAGEMENT\nWIND SPEED\n{dropp_wind['quote']}"],
            dropp_wind["quote"],
        ),
        (
            "prep_advisory",
            "Prep 264-418",
            [f"SPRAY DRIFT ADVISORIES\nWIND\n{prep_gust['quote']}"],
            prep_gust["quote"],
        ),
        (
            "osprey_advisory",
            "Osprey 264-802",
            [f"SPRAY DRIFT ADVISORIES\nWIND\n{osprey_gust['quote']}"],
            osprey_gust["quote"],
        ),
        (
            "axial_advisory",
            "Axial XL 100-1256",
            [f"SPRAY DRIFT ADVISORIES\nWIND\n{find_rule(axial, 'GUSTY WIND CONDITIONS')['quote']}"],
            find_rule(axial, "GUSTY WIND CONDITIONS")["quote"],
        ),
    ]
    in_advisory_section = [
        {
            "name": name,
            "source": source,
            "input": {"pages": pages, "page_no": 1, "quote": quote},
            "expected": modality.in_advisory_section(pages, 1, quote),
        }
        for name, source, pages, quote in advisory_specs
    ]

    return {
        "guards.json": guards,
        "restore_units.json": restore_units,
        "quote_numbers.json": quote_numbers,
        "vote.json": votes,
        "floor_of.json": floor_of,
        "in_advisory_section.json": in_advisory_section,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--spike-root",
        type=pathlib.Path,
        default=ROOT.parent / "research" / "spikes-any-label",
    )
    args = parser.parse_args()
    fixtures = build_fixtures(args.spike_root.resolve())
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, cases in fixtures.items():
        (OUTPUT / name).write_text(
            json.dumps(cases, indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    print(f"wrote {sum(map(len, fixtures.values()))} cases to {OUTPUT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
