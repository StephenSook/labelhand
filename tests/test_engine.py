"""Planner kernel behaviour on a fixed forecast. Fixtures are test inputs, not product data."""

import windows

LAT, LON = 31.40, -83.60  # Tift County, Georgia


def period(start, wind, pop):
    return {"startTime": start, "windSpeed": wind, "temperature": 75, "probabilityOfPrecipitation": {"value": pop}}


def r(param, op, value, modality, quote, rid="t-1"):
    return {"param": param, "op": op, "value": value, "value2": None, "modality": modality, "quote": quote, "id": rid, "page": 1, "product": "TEST", "reg": "0-0"}


WIND = r("wind_speed_mph", "gt", 10, "MUST_NOT", "Do not apply when wind speeds exceed 10 miles per hour.")
CALM = r("wind_speed_mph", "lt", 2, "MUST_NOT", "Application should be avoided below 2 mph due to variable wind direction.")
RAIN = r("rain_free_hours", "lt", 6, "MUST_NOT", "DO NOT APPLY IF RAIN IS EXPECTED WITHIN 6 HOURS.")
INV = r("temperature_inversion", "eq", None, "MUST_NOT", "Do not apply during temperature inversions.")
NOON = "2026-10-07T13:00:00-04:00"


def test_wind_over_the_limit_blocks_and_cites_the_clause():
    out = windows.evaluate([WIND], [period(NOON, "10 to 15 mph", 0)], LAT, LON, 1)[0]
    assert out["state"] == "BLOCKED"
    assert out["blocked"][0]["quote"].startswith("Do not apply when wind speeds exceed 10")


def test_wind_at_the_limit_is_permitted():
    assert windows.evaluate([WIND], [period(NOON, "10 mph", 0)], LAT, LON, 1)[0]["state"] == "PERMITTED"


def test_rain_later_in_the_window_blocks_now():
    ps = [period(NOON, "5 mph", 0)] + [period(NOON, "5 mph", 0)] * 4 + [period(NOON, "5 mph", 80)]
    assert windows.evaluate([RAIN], ps, LAT, LON, 1)[0]["state"] == "BLOCKED"


def test_rain_beyond_the_window_does_not_block():
    ps = [period(NOON, "5 mph", 0)] * 7 + [period(NOON, "5 mph", 90)]
    assert windows.evaluate([RAIN], ps, LAT, LON, 1)[0]["state"] == "PERMITTED"


def test_borderline_rain_is_a_field_check_not_a_permit():
    assert windows.evaluate([RAIN], [period(NOON, "5 mph", 30)], LAT, LON, 1)[0]["state"] == "FIELD_CHECK"


def test_night_hours_need_an_inversion_check():
    out = windows.evaluate([INV], [period("2026-10-07T02:00:00-04:00", "5 mph", 0)], LAT, LON, 1)[0]
    assert out["state"] == "FIELD_CHECK"


def test_midday_breeze_does_not_trigger_inversion_check():
    assert windows.evaluate([INV], [period(NOON, "6 mph", 0)], LAT, LON, 1)[0]["state"] == "PERMITTED"


def test_dead_calm_is_a_field_check():
    assert windows.evaluate([CALM], [period(NOON, "0 mph", 0)], LAT, LON, 1)[0]["state"] == "FIELD_CHECK"


def test_tank_mix_strictest_rule_wins():
    loose = r("wind_speed_mph", "gt", 15, "MUST_NOT", "Do not apply when wind speeds exceed 15 mph.", "t-2")
    out = windows.evaluate([loose, WIND], [period(NOON, "12 mph", 0)], LAT, LON, 1)[0]
    assert out["state"] == "BLOCKED" and len(out["blocked"]) == 1


def test_sun_altitude_is_sane():
    assert windows.sun_altitude(LAT, LON, windows.dt.datetime.fromisoformat(NOON)) > 45
    assert windows.sun_altitude(LAT, LON, windows.dt.datetime.fromisoformat("2026-10-07T02:00:00-04:00")) < -30


def hour(start, temp, daytime, pop=0, wind="5 mph"):
    return {"startTime": start, "windSpeed": wind, "temperature": temp, "isDaytime": daytime, "probabilityOfPrecipitation": {"value": pop}}


NIGHT_ADV = r("night_temperature_f", "lt", 60, "ADVISORY", "If nighttime temperatures are expected to fall below 60F, unsatisfactory defoliation may result.", "t-3")
MEAN_ADV = r("air_temperature_f", "gt", 60, "ADVISORY", "Activity is maximum when the mean 24-hour temperature is above 60F.", "t-4")
RAIN_ADV = r("rainfall_expected", "lt", 24, "ADVISORY", "Rainfall within 24 hours after application will reduce effectiveness.", "t-5")


def test_advisory_reports_a_cold_night_without_changing_the_state():
    ps = [hour(NOON, 75, True)] + [hour("2026-10-08T02:00:00-04:00", 55, False)]
    out = windows.evaluate([NIGHT_ADV], ps, LAT, LON, 1)[0]
    assert out["state"] == "PERMITTED"
    assert out["advisories"][0]["why"].startswith("forecast night low 55 F < 60 F")
    assert out["advisories"][0]["quote"] == NIGHT_ADV["quote"]


def test_warm_night_gives_no_advisory():
    ps = [hour(NOON, 75, True), hour("2026-10-08T02:00:00-04:00", 65, False)]
    assert windows.evaluate([NIGHT_ADV], ps, LAT, LON, 1)[0]["advisories"] == []


def test_mean_temperature_advisory_uses_the_forecast_mean():
    ps = [hour(NOON, 70, True), hour(NOON, 60, False)]
    out = windows.evaluate([MEAN_ADV], ps, LAT, LON, 1)[0]
    assert out["advisories"][0]["why"].startswith("forecast mean 65 F > 60 F")


def test_advisory_rain_never_blocks():
    out = windows.evaluate([RAIN_ADV], [hour(NOON, 75, True, pop=90)], LAT, LON, 1)[0]
    assert out["state"] == "PERMITTED" and out["advisories"]


def test_must_rain_rule_blocks_like_must_not():
    must = r("rain_free_hours", "gte", 6, "MUST", "Apply only if no rain is expected within 6 hours.", "t-6")
    assert windows.evaluate([must], [hour(NOON, 75, True, pop=80)], LAT, LON, 1)[0]["state"] == "BLOCKED"


def test_acting_temperature_clause_is_a_field_check_only_when_its_condition_holds():
    hot = r("air_temperature_f", "gt", 90, "MUST_NOT", "Do not apply when temperatures exceed 90F.", "t-7")
    assert windows.evaluate([hot], [hour(NOON, 75, True)], LAT, LON, 1)[0]["state"] == "PERMITTED"
    out = windows.evaluate([hot], [hour(NOON, 95, True)], LAT, LON, 1)[0]
    assert out["state"] == "FIELD_CHECK" and out["checks"][0]["why"].startswith("forecast temperature now 95 F > 90 F")


def test_cold_night_blocks_an_alone_clause_when_the_tank_has_other_products():
    alone = r("night_temperature_f", "lt", 60, "MUST", "When minimum night temperature is below 60F use FOLEX 6 EC alone.", "t-12")
    alone["product"] = "FOLEX 6 EC"
    dropp = {**WIND, "product": "Dropp SC"}
    prep = {**NIGHT_ADV, "product": "Prep"}
    ps = [hour(NOON, 72, True), hour("2026-10-08T02:00:00-04:00", 56, False)]
    out = windows.evaluate([alone, dropp, prep], ps, LAT, LON, 1)[0]
    assert out["state"] == "BLOCKED"
    assert out["blocked"][0]["why"] == ("forecast night low 56 F < 60 F over the next 2 h: the label says use FOLEX 6 EC alone, and this tank also has Dropp SC, Prep")


def test_cold_night_satisfies_an_alone_clause_when_its_product_is_alone():
    alone = r("night_temperature_f", "lt", 60, "MUST", "When minimum night temperature is below 60F use FOLEX 6 EC alone.", "t-12")
    alone["product"] = "FOLEX 6 EC"
    ps = [hour(NOON, 72, True), hour("2026-10-08T02:00:00-04:00", 56, False)]
    out = windows.evaluate([alone], ps, LAT, LON, 1)[0]
    assert out["state"] == "PERMITTED"
    assert out["blocked"] == [] and out["checks"] == []


def test_warm_night_does_not_apply_an_alone_clause_to_a_mixed_tank():
    alone = r("night_temperature_f", "lt", 60, "MUST", "When minimum night temperature is below 60F use FOLEX 6 EC alone.", "t-12")
    alone["product"] = "FOLEX 6 EC"
    dropp = {**WIND, "product": "Dropp SC"}
    warm = [hour(NOON, 72, True), hour("2026-10-08T02:00:00-04:00", 64, False)]
    out = windows.evaluate([alone, dropp], warm, LAT, LON, 1)[0]
    assert out["state"] == "PERMITTED"
    assert out["blocked"] == [] and out["checks"] == []


def test_a_topic_the_kernel_has_no_logic_for_is_never_silent():
    rh = r("relative_humidity_pct", "lt", 40, "MUST_NOT", "Do not apply when relative humidity is below 40%.", "t-13")
    verdict = windows.gate(rh, 0, [hour(NOON, 75, True)], 5.0, 50.0, {rh["product"]})
    assert verdict[0] == "FIELD_CHECK" and "does not evaluate it yet" in verdict[1]


def test_less_than_ten_blocks_at_exactly_ten():
    lt10 = r("wind_speed_mph", "lt", 10, "MUST", "Apply only when wind speed is less than 10 mph.", "t-8")
    assert windows.evaluate([lt10], [period(NOON, "10 mph", 0)], LAT, LON, 1)[0]["state"] == "BLOCKED"
    assert windows.evaluate([lt10], [period(NOON, "9 mph", 0)], LAT, LON, 1)[0]["state"] == "PERMITTED"


def test_between_sets_both_bounds():
    band = r("wind_speed_mph", "between", 2, "MUST", "Apply only when wind speed is between 2 and 10 mph.", "t-9")
    band["value2"] = 10
    assert windows.evaluate([band], [period(NOON, "12 mph", 0)], LAT, LON, 1)[0]["state"] == "BLOCKED"
    assert windows.evaluate([band], [period(NOON, "1 mph", 0)], LAT, LON, 1)[0]["state"] == "FIELD_CHECK"
    assert windows.evaluate([band], [period(NOON, "6 mph", 0)], LAT, LON, 1)[0]["state"] == "PERMITTED"


def test_advisory_wind_never_gates():
    calm = r("wind_speed_mph", "lt", 2, "ADVISORY", "Application should be avoided below 2 mph.", "t-10")
    assert windows.evaluate([calm], [period(NOON, "0 mph", 0)], LAT, LON, 1)[0]["state"] == "PERMITTED"


def test_advisory_wind_is_reported():
    calm = r("wind_speed_mph", "lt", 2, "ADVISORY", "Application should be avoided below 2 mph.", "t-11")
    out = windows.evaluate([calm], [period(NOON, "0 mph", 0)], LAT, LON, 1)[0]
    assert out["advisories"][0]["why"] == "forecast wind 0 mph < 2 mph"
