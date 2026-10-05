"""The Python kernel must reproduce every frozen fixture exactly. Regenerate with tools/make_engine_fixtures.py
only when the kernel's behaviour is meant to change, and say so in the commit."""

import json
import pathlib

import pytest
import windows

FIXTURES = sorted((pathlib.Path(__file__).parent / "fixtures" / "engine").glob("*.json"))


def test_fixtures_exist():
    assert len(FIXTURES) >= 3  # a parity suite that walks nothing would pass vacuously


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_python_kernel_matches_fixture(path):
    fx = json.loads(path.read_text(encoding="utf-8"))
    got = windows.evaluate(fx["rules"], fx["periods"], fx["lat"], fx["lon"], fx["hours"])
    assert len(got) == fx["hours"] == len(fx["expected"])
    assert got == fx["expected"]


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_fixture_exercises_every_state_kind(path):
    fx = json.loads(path.read_text(encoding="utf-8"))
    hours = fx["expected"]
    assert any(h["blocked"] for h in hours) and any(h["checks"] for h in hours) and any(h["advisories"] for h in hours)
