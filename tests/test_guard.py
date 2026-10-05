"""The compiler's deterministic guards: a rule survives only if its quote is on the page and its numbers are in its quote."""

from compile_label import guard, norm

HALF = chr(0xBD)  # the 1/2 glyph
BAD = chr(0xFFFD)  # what extraction yields for a glyph with no Unicode map

PAGE = norm(
    "Do not apply when wind speed\nexceeds 10 mph. Apply when 60% of bolls are open. "
    f"Do not apply by air within one-half (1/2) mile of lettuce. Do not exceed 2 {HALF} pints per acre. "
    "Do not enter during the restricted-entry interval (REI) of 7 days. Use t hidiazuron when regrowth is heavy."
)


def rule(quote, value=None, value2=None):
    return {"quote": quote, "value": value, "value2": value2}


def test_real_quote_and_number_pass():
    assert guard(rule("Do not apply when wind speed exceeds 10 mph.", 10.0), PAGE) is None


def test_fabricated_quote_is_rejected():
    assert guard(rule("Do not apply when wind exceeds 15 mph.", 15), PAGE) == "QUOTE_NOT_IN_PAGE"


def test_number_not_in_quote_is_rejected():
    assert guard(rule("Do not apply when wind speed exceeds 10 mph.", 12), PAGE).startswith("NUMBER_NOT_IN_QUOTE")


def test_spliced_quote_is_rejected():
    # The Folex failure seen live: two clauses joined with "..." to claim a number that is not there.
    assert guard(rule("Do not enter during the restricted-entry interval (REI) of ... 10 days", 10), PAGE) == "QUOTE_SPLICED"


def test_unit_conversion_by_the_model_is_rejected():
    assert guard(rule("Do not apply by air within one-half (1/2) mile of lettuce.", 2640), PAGE).startswith("NUMBER_NOT_IN_QUOTE")


def test_fraction_and_mixed_number_are_understood():
    assert guard(rule("Do not apply by air within one-half (1/2) mile of lettuce.", 0.5), PAGE) is None
    assert guard(rule(f"Do not exceed 2 {HALF} pints per acre.", 2.5), PAGE) is None


def test_extractor_word_splits_still_match_exactly():
    assert guard(rule("Use thidiazuron when regrowth is heavy."), PAGE) is None


def test_unreadable_glyph_is_not_called_a_model_error():
    page = norm(f"Do not exceed 2 {BAD} pints/A/Year of FOLEX 6 EC.")
    assert guard(rule(f"Do not exceed 2 {BAD} pints/A/Year of FOLEX 6 EC.", 2.5), page).startswith("UNREADABLE_GLYPH")


def test_model_unit_conversion_is_undone_in_code_and_then_passes():
    from compile_label import restore_units

    r = restore_units({"quote": "Do not apply by air within one-half (1/2) mile of lettuce.", "value": 2640, "value2": None, "unit": "feet"})
    assert r["value"] == 0.5 and r["unit"] == "mile" and "undone" in r["unit_restored"]
    assert guard(r, PAGE) is None


def test_inches_back_to_feet():
    from compile_label import restore_units

    q = "Apply with the nozzle no more than 3 feet above the crop canopy."
    r = restore_units({"quote": q, "value": 36, "value2": None, "unit": "inches"})
    assert r["value"] == 3 and r["unit"] == "feet"


def test_a_conversion_code_cannot_reproduce_is_left_for_the_guard_to_reject():
    from compile_label import restore_units

    r = restore_units({"quote": "Do not apply by air within one-half (1/2) mile of lettuce.", "value": 2600, "value2": None, "unit": "feet"})
    assert r["value"] == 2600 and "unit_restored" not in r
    assert guard(r, PAGE).startswith("NUMBER_NOT_IN_QUOTE")
