"""Verify the gold set against the label text itself, so the answer key cannot drift from the labels.

Every gold key must appear (lowercased, whitespace removed, label punctuation folded) on one of the pages
it lists. The label PDFs are not in the repo, so this runs locally after tools/ppls_fetch.py and writes
eval/gold_vN.verified.json beside the gold file, with each label's SHA-256. CI then checks that record is
complete and that its hashes match data/labels/index.json (tests/test_gold_record.py).

Run: python eval/verify_gold.py [--gold eval/gold_v0.json]   (default: the current gold set, v1)
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

from pypdf import PdfReader

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))
from compile_label import norm, squash  # noqa: E402  (shared normaliser keeps gold and guards consistent)

GOLD = ROOT / "eval" / "gold_v1.json"
INDEX = ROOT / "data" / "labels" / "index.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", type=pathlib.Path, default=GOLD)
    gold_path = ap.parse_args().gold
    record_path = gold_path.with_name(gold_path.stem + ".verified.json")
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    record = {"gold_version": gold["version"], "labels": {}}
    missing = 0
    for reg, items in gold["labels"].items():
        meta = index[reg]
        pages = [squash(norm(p.extract_text() or "")) for p in PdfReader(ROOT / meta["file"]).pages]
        found = {}
        for g in items:
            key = squash(norm(g["key"]))
            hits = [n for n in g["pages"] if key in pages[n - 1]]
            anywhere = [n for n, t in enumerate(pages, 1) if key in t]
            found[g["id"]] = {"found_on_listed_page": bool(hits), "pages_found": anywhere}
            if not hits:
                missing += 1
                print(f"MISSING {g['id']} ({reg}) listed {g['pages']}, found on {anywhere or 'no page'}")
        record["labels"][reg] = {"label_sha256": meta["sha256"], "items": found}
    record_path.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8", newline="\n")
    total = sum(len(v) for v in gold["labels"].values())
    print(f"gold items {total}, verified {total - missing}, missing {missing}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
