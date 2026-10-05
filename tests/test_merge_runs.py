"""Repeated compiler runs merge by planner identity and vote on modality."""

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


def test_acting_duplicate_wins_a_two_run_tie():
    quote = "Do not apply when wind speeds exceed 10 mph."
    merged = merge_runs.merge_reports(
        [report(rule(quote, "ADVISORY", rule_id="advisory")), report(rule(quote, "MUST_NOT", rule_id="acting"))],
        ["run-one.json", "run-two.json"],
    )
    assert len(merged["accepted"]) == 1
    assert merged["accepted"][0]["id"] == "acting"
    assert merged["accepted"][0]["modality"] == "MUST_NOT"
    assert merged["accepted"][0]["modality_vote"] == {"ADVISORY": 1, "MUST_NOT": 1}


def test_two_advisory_votes_defeat_one_acting_outlier():
    quote = "Tank mix activity is maximum when temperature is above 60 F."
    merged = merge_runs.merge_reports(
        [
            report(rule(quote, "MUST", param="air_temperature_f", rule_id="acting-outlier")),
            report(rule(quote, "ADVISORY", param="air_temperature_f", rule_id="advisory-two")),
            report(rule(quote, "ADVISORY", param="air_temperature_f", rule_id="advisory-three")),
        ],
        ["run-one.json", "run-two.json", "run-three.json"],
    )
    kept = merged["accepted"][0]
    assert kept["id"] == "advisory-two"
    assert kept["modality"] == "ADVISORY"
    assert kept["modality_by_run"] == {
        "run-one.json": "MUST",
        "run-two.json": "ADVISORY",
        "run-three.json": "ADVISORY",
    }
    assert kept["modality_vote"] == {"ADVISORY": 2, "MUST": 1}


def test_two_acting_votes_defeat_one_advisory_outlier():
    quote = "Do not apply when wind speeds exceed 10 mph."
    merged = merge_runs.merge_reports(
        [
            report(rule(quote, "ADVISORY", rule_id="advisory-outlier")),
            report(rule(quote, "MUST_NOT", rule_id="acting-two")),
            report(rule(quote, "MUST_NOT", rule_id="acting-three")),
        ],
        ["run-one.json", "run-two.json", "run-three.json"],
    )
    kept = merged["accepted"][0]
    assert kept["id"] == "acting-two"
    assert kept["modality"] == "MUST_NOT"
    assert kept["modality_vote"] == {"ADVISORY": 1, "MUST_NOT": 2}


def test_single_run_rule_keeps_its_modality_and_one_vote():
    quote = "Applications should be avoided below 2 mph."
    kept = merge_runs.merge_reports(
        [report(rule(quote, "ADVISORY")), report(), report()],
        ["run-one.json", "run-two.json", "run-three.json"],
    )["accepted"][0]
    assert kept["modality"] == "ADVISORY"
    assert kept["modality_by_run"] == {"run-one.json": "ADVISORY"}
    assert kept["modality_vote"] == {"ADVISORY": 1}


def test_three_way_split_keeps_the_first_acting_modality():
    quote = "Apply only when wind is below 10 mph."
    merged = merge_runs.merge_reports(
        [
            report(rule(quote, "ADVISORY", rule_id="advisory")),
            report(rule(quote, "MUST", rule_id="first-acting")),
            report(rule(quote, "MUST_NOT", rule_id="second-acting")),
        ],
        ["run-one.json", "run-two.json", "run-three.json"],
    )
    kept = merged["accepted"][0]
    assert kept["id"] == "first-acting"
    assert kept["modality"] == "MUST"
    assert kept["modality_vote"] == {"ADVISORY": 1, "MUST": 1, "MUST_NOT": 1}


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
    assert kept["modality_vote"] == {"ADVISORY": 1, "MUST": 1}
    assert merged["merged_from"] == ["run-one.json", "run-two.json"]
