"""Check-back tests use synthetic-shape weather and rule records only."""

import checkback


def acting_rule(param="wind_speed_mph", op="lte", value=10, rule_id="synthetic-wind"):
    return {
        "id": rule_id,
        "page": 1,
        "product": "SYNTHETIC PRODUCT",
        "reg": "0-0",
        "param": param,
        "op": op,
        "value": value,
        "value2": None,
        "unit": "mph",
        "modality": "MUST",
        "quote": "Synthetic-shape clause for a unit test.",
    }


def observation(wind_kmh=16.09344, temperature_c=0.0, rain_mm=0.0):
    return {
        "windSpeed": {"unitCode": "wmoUnit:km_h-1", "value": wind_kmh},
        "temperature": {"unitCode": "wmoUnit:degC", "value": temperature_c},
        "precipitationLastHour": {"unitCode": "wmoUnit:mm", "value": rain_mm},
    }


def test_exact_unit_conversions():
    assert checkback.kmh_to_mph(16.09344) == 10.0
    assert checkback.celsius_to_fahrenheit(0.0) == 32.0
    assert checkback.celsius_to_fahrenheit(10.0) == 50.0


def test_inclusive_wind_limit_holds_at_ten_mph():
    result = checkback.check_permitted_rules([acting_rule()], checkback.observed_weather(observation()))
    assert result["outcome"] == "held"
    assert result["checks"][0]["observed"]["value"] == 10.0


def test_planted_broken_hour_is_reported_once_with_clause_and_value():
    wind = acting_rule()
    duplicate = {**wind, "id": "synthetic-wind-duplicate"}
    weather = checkback.observed_weather(observation(wind_kmh=20.921472))
    result = checkback.check_permitted_rules([wind, duplicate], weather)
    counts = checkback.empty_counts()
    checkback.add_permitted_outcome(counts, result)

    assert result["outcome"] == "broke"
    assert counts["permitted_a_day_ahead"] == 1
    assert counts["broke"] == 1
    assert counts["held"] == 0
    assert {item["observed"]["value"] for item in result["checks"]} == {13.0}
    assert {item["rule"] for item in result["checks"]} == {"synthetic-wind", "synthetic-wind-duplicate"}


def test_inversion_and_rainfast_are_not_counted_as_held():
    inversion = acting_rule("temperature_inversion", "none", None, "synthetic-inversion")
    rainfast = acting_rule("rain_free_hours", "gte", 6, "synthetic-rainfast")
    result = checkback.check_permitted_rules([inversion, rainfast], checkback.observed_weather(observation()))
    counts = checkback.empty_counts()
    checkback.add_permitted_outcome(counts, result)

    assert result["outcome"] == "not_checkable"
    assert counts["held"] == 0
    assert counts["not_checkable_only"] == 1
    assert len(result["not_checkable_rule_keys"]) == 2


def test_synthetic_lower_wind_bound_reports_calm_as_broken():
    lower = acting_rule("wind_speed_mph", "between", 2, "synthetic-band")
    lower["value2"] = 10
    result = checkback.check_permitted_rules([lower], checkback.observed_weather(observation(wind_kmh=1.609344)))
    assert result["outcome"] == "broke"
    assert result["checks"][0]["observed"]["value"] == 1.0


def test_headline_uses_checked_hours_and_names_missing_measurements():
    pooled = {
        "held": 2,
        "broke": 1,
        "permitted_a_day_ahead": 4,
        "skipped": {"missing_measurement": 1},
    }
    results = {
        "tank_mix": {"pooled": pooled},
        **{registration: {"pooled": pooled} for registration in checkback.REGISTRATIONS},
    }
    headline = checkback.build_headline(results)
    assert "2 of 3 checked hours (tank mix)" in headline
    assert "1 additional permitted tank-mix hours lacked observed wind" in headline
