"""Two readings of a page: a quote is rescued only where each disagreement is confirmed by the other reading."""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))

import two_readings  # noqa: E402

D = chr(0xFFFD)
# The real Dropp SC sentence as each reading gives it (label 264-700, page 5).
LAYER = (
    f"3. High moisture content in leaf of cotton plant ) J \\}}.,):) Use of Dropp{D} SC alone (without a tank mix partner) "
    f"when nighttime temperatures are expected to fall below 60{D}F can result in less\"ti'liln desirable \n"
    "defoliation and/or regrowth inhibition. ,~, c) Performance of Dropp"
)
OCR = (
    "3. High moisture content in leaf of cotton plant\nUse of Dropp^{\\1} SC alone (without a tank mix partner) when nighttime "
    f"temperatures are expected to fall below 60{D}F can result in less than desirable defoliation and/or growth inhibition.\n"
)
QUOTE = (
    f"Use of Dropp{D} SC alone (without a tank mix partner) when nighttime temperatures are expected to fall below 60{D}F "
    "can result in less than desirable defoliation and/or regrowth inhibition."
)


def test_each_reading_fixes_the_others_error():
    # The layer garbled "than"; the OCR dropped "re" from "regrowth". The quote is confirmed span by span.
    assert two_readings.check(QUOTE, LAYER, OCR) == "text layer + ocr"


def test_a_wrong_quote_is_still_rejected():
    wrong = QUOTE.replace("less than desirable", "less desirable")
    assert two_readings.check(wrong, LAYER, OCR) is None
    made_up = QUOTE.replace("below 60", "below 50")
    assert two_readings.check(made_up, LAYER, OCR) is None


def test_quote_found_verbatim_in_the_ocr_alone():
    q = "Use of Dropp SC alone (without a tank mix partner) when nighttime temperatures are expected to fall below 60"
    assert two_readings.check(q, "unrelated text", OCR) == "ocr"


def test_spliced_and_short_quotes_never_pass():
    assert two_readings.check("Use of Dropp SC alone ... regrowth inhibition.", LAYER, OCR) is None
    assert two_readings.check("less than desirable", "less'ti desirable", "zzz") is None


def test_trademark_glyphs_are_ignored_on_both_sides():
    assert two_readings.flat(f"Dropp{D} SC") == two_readings.flat("Dropp^{\\1} SC") == "droppsc"
