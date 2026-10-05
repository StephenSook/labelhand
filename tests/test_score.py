"""Scorer regressions for planner rules whose modality changes behavior."""

from score import score_label  # eval/ is on pytest's pythonpath (pyproject.toml), like compiler/ and engine/


def test_acting_rule_matching_only_advisory_gold_is_false_positive():
    gold = [
        {
            "id": "F-TEMP-60",
            "key": "mean 24-hour temperature before and after application is above 60",
            "param": "air_temperature_f",
            "op": "gt",
            "value": 60,
            "unit": "F",
            "modality": "ADVISORY",
        }
    ]
    rules = [
        {
            "id": "5481-504-p10-5",
            "param": "air_temperature_f",
            "op": "gt",
            "value": 60,
            "modality": "MUST",
            "quote": "The mean 24-hour temperature before and after application is above 60 F.",
        }
    ]

    score = score_label(gold, rules)

    assert score["planner_precision"] == 1.0
    assert score["acting_precision"] == 0.0
    assert score["acting_good"] == 0
    assert score["acting_false_positives"] == [
        {
            "id": "5481-504-p10-5",
            "param": "air_temperature_f",
            "gold_modalities": ["ADVISORY"],
            "quote": "The mean 24-hour temperature before and after application is above 60 F.",
        }
    ]
