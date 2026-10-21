"""The /changes page data: rules matched by sentence, label changes told apart from compile differences, hours recounted."""

from __future__ import annotations

import json

import label_changes
import pytest


def _rule(quote: str, param: str = "wind_speed_mph", **kw) -> dict:
    base = {"id": "x-p1-1", "page": 1, "param": param, "op": "gt", "value": 10, "value2": None, "unit": "mph", "modality": "MUST_NOT", "quote": quote}
    return {**base, **kw}


WIND = "Do not apply when wind speeds exceed 10 mph."


def test_same_sentence_and_numbers_is_unchanged_even_with_other_spacing_and_10_vs_10_0():
    diff = label_changes.rule_diff([_rule(WIND, value=10.0)], [_rule("Do not apply when wind  speeds exceed 10 mph", value=10, page=4)])
    assert diff == {"added": [], "removed": [], "changed": [], "unchanged": 1}


def test_a_new_number_in_the_sentence_is_one_rule_removed_and_one_added():
    diff = label_changes.rule_diff([_rule("Do not apply when wind speeds exceed 15 mph.", value=15)], [_rule(WIND)])
    assert [a["shipped"]["value"] for a in diff["added"]] == [15]
    assert [r["previous"]["value"] for r in diff["removed"]] == [10]
    assert diff["changed"] == []


def test_same_sentence_typed_with_another_modality_or_parameter_is_changed():
    modality = label_changes.rule_diff([_rule(WIND, modality="ADVISORY")], [_rule(WIND)])
    assert modality["changed"][0]["fields"] == ["modality"]
    param = label_changes.rule_diff([_rule(WIND, param="application_method", op="none", value=None, unit=None)], [_rule(WIND)])
    assert param["changed"][0]["fields"] == ["param", "op", "value", "unit"]
    assert param["added"] == param["removed"] == []


def test_planner_role_matches_the_kernel_topic_check_and_crop_scope():
    assert label_changes.view(_rule(WIND))["planner"] == "acting"
    assert label_changes.view(_rule(WIND, modality="ADVISORY"))["planner"] == "advisory"
    assert label_changes.view(_rule("Use a coarse droplet.", param="droplet_size"))["planner"] == "not read"
    tobacco = _rule("Only apply if temperatures are below 65 F.", param="air_temperature_f", op="lt", value=65, unit="F", applies_to="tobacco")
    assert label_changes.view(tobacco)["planner"] == "not read"


def _hours(*winds: str) -> list[dict]:
    return [
        {"startTime": f"2026-10-06T{h:02d}:00:00-04:00", "isDaytime": True, "temperature": 80, "windSpeed": wind, "probabilityOfPrecipitation": {"value": 0}}
        for h, wind in enumerate(winds)
    ]


def test_hours_moved_counts_only_hours_whose_state_changes_and_names_the_clause():
    fixture = {"lat": 31.4, "lon": -83.6, "periods": _hours("5 mph", "12 mph", "16 mph")}
    ten = {**_rule(WIND), "product": "P", "reg": "0-0"}
    fifteen = {**_rule("Do not apply when wind speeds exceed 15 mph.", value=15), "product": "P", "reg": "0-0"}
    moved = label_changes.hours_moved([fifteen], [ten], fixture)
    assert moved["hours"] == 3
    assert moved["changed"] == 1  # 12 mph: blocked by the 10 mph sentence, permitted under 15 mph
    assert moved["transitions"] == {"BLOCKED->PERMITTED": 1}
    assert moved["moved"][0]["only_previous"] == [label_changes.quote_key(WIND)]
    assert moved["moved"][0]["only_shipped"] == []


def test_committed_changes_data_is_current():
    committed = label_changes.OUT.read_text(encoding="utf-8")
    assert committed == label_changes.render(label_changes.build()), "run python tools/label_changes.py"


def test_every_compiled_label_has_a_text_check_for_the_exact_pdfs_and_every_added_or_removed_sentence():
    data = label_changes.build()
    receipt = json.loads(label_changes.COMPILE_RECEIPT.read_text(encoding="utf-8"))
    text = json.loads(label_changes.LABEL_TEXT.read_text(encoding="utf-8"))["labels"]
    compiled = [reg for reg, entry in data["labels"].items() if entry["compiled"]]
    assert compiled, "a check that covers no label must fail"
    assert set(compiled) == {reg for reg, entry in receipt["labels"].items() if entry["compiled"]}
    for reg in compiled:
        entry = data["labels"][reg]
        assert text[reg]["shipped_sha256"] == entry["shipped"]["sha256"]
        assert text[reg]["previous_sha256"] == entry["previous"]["sha256"]
        keys = {item["key"] for item in entry["rules"]["added"] + entry["rules"]["removed"]}
        assert keys == set(text[reg]["quotes"]), reg
        # A sentence a compile accepted passed the quote guard on its own label, so the text check must find it there.
        for item in entry["rules"]["added"]:
            assert text[reg]["quotes"][item["key"]]["in_shipped"], item["key"]
        for item in entry["rules"]["removed"]:
            assert text[reg]["quotes"][item["key"]]["in_previous"], item["key"]
        for point, hours in entry["hours"].items():
            assert hours["tank"]["hours"] == data["forecasts"][point]["hours"] == 156


def test_a_label_not_compiled_says_why_and_carries_no_rule_or_hour_numbers():
    data = label_changes.build()
    for entry in data["labels"].values():
        if entry["compiled"]:
            continue
        assert entry["why_not_compiled"]
        assert "rules" not in entry and "hours" not in entry


@pytest.mark.parametrize("field", ["value", "value2"])
def test_numbers_compare_as_numbers(field):
    assert label_changes.same(field, 10, 10.0)
    assert not label_changes.same(field, 10, None)
    assert label_changes.same(field, None, None)
