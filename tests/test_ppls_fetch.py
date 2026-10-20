"""A label re-fetch must not erase fields a person wrote into data/labels/index.json."""

import pytest
from ppls_fetch import merge_record, parse_ppls_json  # tools/ is on pytest's pythonpath (pyproject.toml)


def test_refetch_keeps_short_name_and_takes_new_fetch_fields():
    prev = {"reg": "264-700", "product": "DROPP SC COTTON DEFOLIANT", "shortName": "Dropp SC", "sha256": "old"}
    rec = {"reg": "264-700", "product": "DROPP SC COTTON DEFOLIANT", "sha256": "new"}

    merged = merge_record(prev, rec)

    assert merged["shortName"] == "Dropp SC"
    assert merged["sha256"] == "new"


def test_first_fetch_has_no_curated_fields():
    rec = {"reg": "5481-504", "product": "FOLEX 6 EC", "sha256": "abc"}

    assert merge_record(None, rec) == rec


# Shape of https://ordspub.epa.gov/ords/pesticides/cswu/ppls/228-653 as read on 2026-10-20, trimmed.
PPLS_JSON = {
    "items": [
        {
            "eparegno": "228-653",
            "productname": "FREEFALL SC COTTON DEFOLIANT",
            "pdffiles": [
                {"pdffile": "000228-00653-20190211.pdf"},
                {"pdffile": "000228-00653-20210514.pdf"},
                {"pdffile": "000264-00700-20120101.pdf"},
                {"pdffile": ""},
            ],
        }
    ]
}


def test_json_record_gives_name_and_only_this_registrations_versions_newest_first():
    name, versions = parse_ppls_json("228-653", PPLS_JSON)

    assert name == "FREEFALL SC COTTON DEFOLIANT"
    assert [v["accepted"] for v in versions] == ["2021-05-14", "2019-02-11"]
    assert versions[0]["url"] == "https://www3.epa.gov/pesticides/chem_search/ppls/000228-00653-20210514.pdf"


def test_json_answer_for_another_registration_is_refused():
    with pytest.raises(RuntimeError, match="no record for 228-659"):
        parse_ppls_json("228-659", PPLS_JSON)
