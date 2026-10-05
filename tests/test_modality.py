"""The PR Notice 2000-5 modality floor: raises directive weather gates, leaves everything else to the model."""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))

import modality  # noqa: E402

FOLEX_NIGHT = "When minimum night temperature is below 60" + chr(0xB0) + "F use FOLEX 6 EC alone."


def rule(quote: str, param: str = "night_temperature_f", modality_: str = "ADVISORY", page: int = 2) -> dict:
    return {"id": "x", "param": param, "modality": modality_, "quote": quote, "page": page}


def test_imperative_after_a_condition_that_gates_the_product_is_mandatory():
    assert modality.floor_of(FOLEX_NIGHT, brand="folex") == "MUST"


def test_prohibition_is_must_not():
    assert modality.floor_of("Do not apply when wind speeds exceed 10 mph at the application site.") == "MUST_NOT"


def test_a_mandatory_technique_is_not_a_weather_gate():
    quote = "If the windspeed is 10 miles per hour or less, applicators must use 1/2 swath displacement upwind."
    assert modality.floor_of(quote, brand="folex") is None


def test_suggestive_terms_leave_the_model_alone_even_when_the_pdf_split_the_word():
    assert modality.floor_of("Applications should not be made when rain is expected.") is None
    assert modality.floor_of("Use of a nurse tank is highly re commended for avoiding spills.") is None


def test_use_of_is_a_noun_not_an_imperative():
    assert modality.floor_of("Use of this product during inversions increases drift.", brand="folex") is None


PAGES = [
    "DIRECTIONS FOR USE\nApply by ground.",
    "SPRAY DRIFT ADVISORIES\nTHE APPLICATOR IS RESPONSIBLE FOR AVOIDING OFF-SITE SPRAY DRIFT.\nTEMPERATURE AND HUMIDITY\n"
    "When making applications in hot and dry conditions, apply larger droplets to reduce evaporation.\n"
    "DEFOLIATION AND BOLL OPENING\n" + FOLEX_NIGHT,
]


def test_advisory_section_runs_until_a_heading_outside_the_standard_drift_advisories():
    assert modality.in_advisory_section(PAGES, 2, "When making applications in hot and dry conditions") is True
    assert modality.in_advisory_section(PAGES, 2, FOLEX_NIGHT) is False
    assert modality.in_advisory_section(PAGES, 2, "a sentence that is not on the page") is None


def test_apply_floor_raises_only_outside_advisory_sections_and_records_why():
    raised = modality.apply_floor(rule(FOLEX_NIGHT), PAGES, "folex")
    assert raised["modality"] == "MUST" and raised["modality_model"] == "ADVISORY"
    assert "PR Notice 2000-5" in raised["modality_floor"]
    hot = rule("When making applications in hot and dry conditions, apply larger droplets to reduce evaporation.", param="air_temperature_f")
    assert modality.apply_floor(hot, PAGES, "folex")["modality"] == "ADVISORY"


def test_apply_floor_never_lowers_and_ignores_parameters_the_planner_cannot_act_on():
    must = rule(FOLEX_NIGHT, modality_="MUST")
    assert modality.apply_floor(must, PAGES, "folex") is must
    rate = rule("Use the higher FOLEX 6 EC rate under conditions of low temperature.", param="rate_per_acre")
    assert modality.apply_floor(rate, PAGES, "folex")["modality"] == "ADVISORY"


def test_no_page_text_means_no_floor():
    assert modality.apply_floor(rule(FOLEX_NIGHT), None, "folex")["modality"] == "ADVISORY"
