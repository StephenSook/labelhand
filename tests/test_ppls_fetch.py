"""A label re-fetch must not erase fields a person wrote into data/labels/index.json."""

from ppls_fetch import merge_record  # tools/ is on pytest's pythonpath (pyproject.toml)


def test_refetch_keeps_short_name_and_takes_new_fetch_fields():
    prev = {"reg": "264-700", "product": "DROPP SC COTTON DEFOLIANT", "shortName": "Dropp SC", "sha256": "old"}
    rec = {"reg": "264-700", "product": "DROPP SC COTTON DEFOLIANT", "sha256": "new"}

    merged = merge_record(prev, rec)

    assert merged["shortName"] == "Dropp SC"
    assert merged["sha256"] == "new"


def test_first_fetch_has_no_curated_fields():
    rec = {"reg": "5481-504", "product": "FOLEX 6 EC", "sha256": "abc"}

    assert merge_record(None, rec) == rec
