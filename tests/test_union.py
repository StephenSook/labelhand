"""Union of two extraction passes: every clause either pass found, each kept once, with who found it."""

import json

import union


def _rule(quote, param="wind_speed_mph", page=1):
    return {"id": "x", "page": page, "param": param, "op": "gt", "value": 10, "value2": None, "unit": "mph", "modality": "MUST_NOT", "quote": quote}


def test_union_keeps_each_clause_once_and_records_both_finders(tmp_path, monkeypatch):
    monkeypatch.setattr(union, "COMPILED", tmp_path)
    wind = "Do not apply when wind speeds exceed 10 mph."
    a = {"reg": "0-0", "model": "super", "cost_usd": 0.01, "accepted": [_rule(wind)], "rejected": []}
    b = {
        "reg": "0-0",
        "model": "ultra",
        "cost_usd": 0.02,
        "accepted": [_rule("Do not apply when wind  speeds exceed 10 mph."), _rule("Do not apply during temperature inversions.", "temperature_inversion")],
        "rejected": [],
    }
    (tmp_path / "0-0.json").write_text(json.dumps(a), encoding="utf-8")
    (tmp_path / "0-0.u.json").write_text(json.dumps(b), encoding="utf-8")
    u = union.union("0-0", ["", ".u"])
    assert len(u["accepted"]) == 2
    finders = {r["param"]: r["found_by"] for r in u["accepted"]}
    assert finders["wind_speed_mph"] == ["super", "ultra"]
    assert finders["temperature_inversion"] == ["ultra"]
    assert u["cost_usd"] == 0.03
