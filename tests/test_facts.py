"""Keep JSON-backed measured claims in FACTS.md tied to their committed sources."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FACTS = ROOT / "FACTS.md"
JSON_SOURCE = re.compile(r"json:([^#`;\s]+)#([A-Za-z0-9_.-]+)")


def measured_rows() -> list[tuple[str, str, str]]:
    rows = []
    for line in FACTS.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) == 4 and cells[3] == "MEASURED" and cells[0] != "Claim":
            rows.append((cells[0], cells[1], cells[2]))
    return rows


def lookup(value: Any, key: str) -> Any:
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            raise AssertionError(f"JSON key {key!r} does not exist")
        value = value[part]
    return value


def assert_subset(actual: Any, expected: Any, claim: str) -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{claim}: source value is not an object"
        for key, value in expected.items():
            assert key in actual, f"{claim}: source object has no {key!r}"
            assert_subset(actual[key], value, f"{claim}.{key}")
        return
    assert actual == expected, f"{claim}: FACTS.md has {expected!r}, source has {actual!r}"


def test_measured_json_sources_match_fact_sheet() -> None:
    checked = 0
    for claim, exact, source in measured_rows():
        match = JSON_SOURCE.search(source)
        if match is None:
            continue
        path = ROOT / match.group(1)
        assert path.is_file(), f"{claim}: JSON source does not exist: {path.relative_to(ROOT)}"
        assert exact.startswith("`") and exact.endswith("`"), f"{claim}: exact value must be one JSON code span"
        expected = json.loads(exact[1:-1])
        actual = lookup(json.loads(path.read_text(encoding="utf-8")), match.group(2))
        assert_subset(actual, expected, claim)
        checked += 1
    assert checked >= 30, f"expected at least 30 JSON-backed measured rows, checked {checked}"
