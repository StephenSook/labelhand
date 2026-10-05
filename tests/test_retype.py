"""The typing pass may change a rule's type, but never at the cost of an unverifiable number."""

import json

import retype


def _src(tmp_path):
    rule = {
        "id": "x-p1-1",
        "page": 1,
        "param": "night_temperature_f",
        "op": "none",
        "value": None,
        "value2": None,
        "unit": None,
        "modality": "ADVISORY",
        "quote": "Use of a nurse tank is highly recommended.",
    }
    num = {
        "id": "x-p1-2",
        "page": 1,
        "param": "wind_speed_mph",
        "op": "gt",
        "value": 10,
        "value2": None,
        "unit": "mph",
        "modality": "MUST_NOT",
        "quote": "Do not apply when wind speeds exceed 10 mph.",
    }
    (tmp_path / "0-0.json").write_text(json.dumps({"reg": "0-0", "accepted": [rule, num], "rejected": []}), encoding="utf-8")


def test_retype_fixes_the_type_and_keeps_good_numbers(tmp_path, monkeypatch):
    _src(tmp_path)
    monkeypatch.setattr(retype, "COMPILED", tmp_path)
    monkeypatch.setenv("NEBIUS_API_KEY", "test")
    answers = {
        "Use of a nurse tank is highly recommended.": {"param": "other", "op": "none", "value": None, "value2": None, "unit": None, "modality": "ADVISORY"},
        "Do not apply when wind speeds exceed 10 mph.": {"param": "wind_speed_mph", "op": "gt", "value": 12, "value2": None, "unit": "mph", "modality": "MUST_NOT"},
    }
    monkeypatch.setattr(retype, "call", lambda model, rule, key: {"ok": True, "typed": answers[rule["quote"]], "usage": {}})
    out = retype.retype("0-0", retype.DEFAULT_MODEL, "")
    by_id = {r["id"]: r for r in out["accepted"]}
    assert by_id["x-p1-1"]["param"] == "other" and by_id["x-p1-1"]["agreed"] is False
    # 12 is not in the quote: the first pass (10) is kept and the bad second opinion is recorded
    assert by_id["x-p1-2"]["value"] == 10 and by_id["x-p1-2"]["retype_rejected"].startswith("NUMBER_NOT_IN_QUOTE")
    assert out["rejected"] == []
