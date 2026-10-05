"""Repeated compiler runs merge by planner identity with acting modalities kept safe."""

import merge_runs


def rule(quote: str, modality: str = "ADVISORY", param: str = "wind_speed_mph", rule_id: str = "rule") -> dict:
    return {
        "id": rule_id,
        "page": 1,
        "param": param,
        "op": "gt",
        "value": 10,
        "value2": None,
        "unit": "mph",
        "modality": modality,
        "quote": quote,
    }


def report(*rules: dict) -> dict:
    return {
        "product": "Test product",
        "reg": "0-0",
        "model": "test-model",
        "accepted": list(rules),
        "rejected": [],
    }


def test_rule_key_matches_planner_normalization():
    first = rule("Do not apply when wind speeds exceed 10 mph.")
    second = rule("do NOT apply---when wind speeds exceed 10 mph!!!")
    assert merge_runs.rule_key(first) == merge_runs.rule_key(second)
    assert merge_runs.rule_key(rule(first["quote"], param="rain_free_hours")) != merge_runs.rule_key(first)


def test_acting_duplicate_wins_over_the_first_advisory():
    quote = "Do not apply when wind speeds exceed 10 mph."
    merged = merge_runs.merge_reports(
        [report(rule(quote, "ADVISORY", rule_id="advisory")), report(rule(quote, "MUST_NOT", rule_id="acting"))],
        ["run-one.json", "run-two.json"],
    )
    assert len(merged["accepted"]) == 1
    assert merged["accepted"][0]["id"] == "acting"
    assert merged["accepted"][0]["modality"] == "MUST_NOT"


def test_found_in_runs_and_modalities_record_each_source_once():
    quote = "Applications should not be made when rain is expected within 6 hours."
    merged = merge_runs.merge_reports(
        [
            report(rule(quote, "ADVISORY", param="rain_free_hours"), rule(quote, "MUST", param="rain_free_hours")),
            report(rule(quote, "ADVISORY", param="rain_free_hours")),
        ],
        ["run-one.json", "run-two.json"],
    )
    kept = merged["accepted"][0]
    assert kept["found_in_runs"] == ["run-one.json", "run-two.json"]
    assert kept["modality_by_run"] == {"run-one.json": "MUST", "run-two.json": "ADVISORY"}
    assert merged["merged_from"] == ["run-one.json", "run-two.json"]
