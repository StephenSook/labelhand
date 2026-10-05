"""CI half of the gold-set check (eval/verify_gold.py is the local half that reads the label PDFs).

The record must name every gold clause, every clause must have been found on a page it lists, and the
label hashes must match the labels the compiler used. A floor on the count stops an empty record from
passing as clean.
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
GOLD = json.loads((ROOT / "eval" / "gold_v0.json").read_text(encoding="utf-8"))
RECORD = json.loads((ROOT / "eval" / "gold_v0.verified.json").read_text(encoding="utf-8"))
INDEX = json.loads((ROOT / "data" / "labels" / "index.json").read_text(encoding="utf-8"))
MIN_ITEMS = 46


def test_record_covers_every_gold_clause():
    gold_ids = {g["id"] for items in GOLD["labels"].values() for g in items}
    record_ids = {i for lab in RECORD["labels"].values() for i in lab["items"]}
    assert len(gold_ids) >= MIN_ITEMS
    assert gold_ids == record_ids


def test_every_clause_was_found_on_a_listed_page():
    misses = [i for lab in RECORD["labels"].values() for i, v in lab["items"].items() if not v["found_on_listed_page"]]
    assert misses == []


def test_record_was_made_against_the_labels_in_use():
    for reg, lab in RECORD["labels"].items():
        assert lab["label_sha256"] == INDEX[reg]["sha256"], reg


def test_gold_ids_are_unique():
    ids = [g["id"] for items in GOLD["labels"].values() for g in items]
    assert len(ids) == len(set(ids))
