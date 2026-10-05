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
