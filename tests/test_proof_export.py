"""The /proof page data must be the exporter's output for the committed inputs, and list every case."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import proof_export  # noqa: E402


def test_committed_proof_data_is_current() -> None:
    committed = proof_export.OUT.read_text(encoding="utf-8")
    assert committed == proof_export.render(proof_export.build()), "run python tools/proof_export.py"


def test_every_gold_clause_and_every_broken_hour_is_listed() -> None:
    data = proof_export.build()
    gold = json.loads(proof_export.GOLD.read_text(encoding="utf-8"))
    assert len(data["gold"]) == sum(len(items) for items in gold["labels"].values())
    checkback = json.loads(proof_export.CHECKBACK.read_text(encoding="utf-8"))
    assert len(data["checkback"]["misses"]) == checkback["tank_mix"]["pooled"]["broke"]
    for miss in data["checkback"]["misses"]:
        assert miss["broken"], miss
        assert all(rule in data["checkback"]["rules"] for rule in miss["broken"])
