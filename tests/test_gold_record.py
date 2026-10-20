"""CI half of the gold-set check (eval/verify_gold.py is the local half that reads the label PDFs).

The record must name every gold clause, every clause must have been found on a page it lists, and the
label hashes must match the labels the compiler used. A floor on the count stops an empty record from
passing as clean. v1 scores the shipped tank; v0, the development tank, is kept so its published
numbers stay checkable.
"""

import json
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
INDEX = json.loads((ROOT / "data" / "labels" / "index.json").read_text(encoding="utf-8"))
# gold version -> (minimum clause count, registrations it must cover)
VERSIONS = {
    "v0": (46, {"5481-504", "264-700", "264-418"}),
    "v1": (64, {"5481-504", "228-653", "228-659"}),
}


def load(version: str) -> tuple[dict, dict]:
    gold = json.loads((ROOT / "eval" / f"gold_{version}.json").read_text(encoding="utf-8"))
    record = json.loads((ROOT / "eval" / f"gold_{version}.verified.json").read_text(encoding="utf-8"))
    return gold, record


@pytest.mark.parametrize("version", VERSIONS)
def test_record_covers_every_gold_clause(version):
    gold, record = load(version)
    minimum, regs = VERSIONS[version]
    gold_ids = {g["id"] for items in gold["labels"].values() for g in items}
    record_ids = {i for lab in record["labels"].values() for i in lab["items"]}
    assert gold["version"] == record["gold_version"] == version
    assert set(gold["labels"]) == set(record["labels"]) == regs
    assert len(gold_ids) >= minimum
    assert gold_ids == record_ids


@pytest.mark.parametrize("version", VERSIONS)
def test_every_clause_was_found_on_a_listed_page(version):
    _, record = load(version)
    misses = [i for lab in record["labels"].values() for i, v in lab["items"].items() if not v["found_on_listed_page"]]
    assert misses == []


@pytest.mark.parametrize("version", VERSIONS)
def test_record_was_made_against_the_labels_in_use(version):
    _, record = load(version)
    for reg, lab in record["labels"].items():
        assert lab["label_sha256"] == INDEX[reg]["sha256"], reg


@pytest.mark.parametrize("version", VERSIONS)
def test_gold_ids_are_unique(version):
    gold, _ = load(version)
    ids = [g["id"] for items in gold["labels"].values() for g in items]
    assert len(ids) == len(set(ids))


def test_v1_carries_the_folex_clauses_over_unchanged():
    v0, _ = load("v0")
    v1, _ = load("v1")
    assert v1["labels"]["5481-504"] == v0["labels"]["5481-504"]
