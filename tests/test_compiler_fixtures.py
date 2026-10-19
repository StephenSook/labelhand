"""Compiler fixtures stay small, complete, and tied to all five source labels."""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "web" / "tests" / "fixtures" / "compiler"
EXPECTED_FILES = {
    "floor_of.json",
    "guards.json",
    "in_advisory_section.json",
    "quote_numbers.json",
    "restore_units.json",
    "vote.json",
}
EXPECTED_SOURCES = {
    "Folex 6 EC 5481-504",
    "Dropp SC 264-700",
    "Prep 264-418",
    "Osprey 264-802",
    "Axial XL 100-1256",
}


def test_compiler_fixture_inventory_and_guard_reasons():
    files = {path.name for path in FIXTURES.glob("*.json")}
    assert files == EXPECTED_FILES
    loaded = {name: json.loads((FIXTURES / name).read_text(encoding="utf-8")) for name in files}
    sources = {case["source"] for cases in loaded.values() for case in cases}
    assert sources == EXPECTED_SOURCES
    assert {case["expected"].split(":")[0] for case in loaded["guards.json"] if case["expected"]} == {
        "QUOTE_TOO_SHORT",
        "QUOTE_SPLICED",
        "QUOTE_NOT_IN_PAGE",
        "NUMBER_NOT_IN_QUOTE",
        "UNREADABLE_GLYPH",
    }
    assert any(case["expected"] is None for case in loaded["guards.json"])


def test_compiler_fixtures_contain_only_small_text_snippets():
    for path in FIXTURES.glob("*.json"):
        assert path.stat().st_size < 30_000
        text = path.read_text(encoding="utf-8")
        assert "%PDF-" not in text
