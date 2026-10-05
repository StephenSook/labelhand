"""Second reading of the page: rescue quotes the PDF text layer garbled, using NVIDIA Nemotron Parse OCR.

Dropp SC's EPA label is a 2009 scan whose text layer reads "less"ti'liln desirable" where the page says "less than
desirable". The compiler's guard requires every quote to be on the page, so the model's correct quote of that
sentence was rejected in every run, and two gold clauses (D-NIGHT-ALONE, D-NIGHT-IDEAL) were never covered.
tools/ocr_job/ reads every page again with nvidia/NVIDIA-Nemotron-Parse-2.0 on a Nebius AI Cloud L40S. OCR makes its
own mistakes (it read "regrowth" as "growth" in the same sentence), so neither reading is trusted alone.

A rejected QUOTE_NOT_IN_PAGE rule is accepted only when one of these holds:
  - the quote is in the OCR text of its page exactly (quote_check "ocr"), or
  - the quote matches one reading except in short spans, and every one of those spans, with 8 characters of the
    quote on each side, appears exactly in the other reading ("text layer + ocr" or "ocr + text layer").
Comparison ignores whitespace and case like the main guard, and also trademark glyphs, which the text layer prints as
U+FFFD and the OCR as LaTeX superscripts. Spliced quotes stay rejected. The number guard runs again on every rescued
rule, and the rule is typed by the same typing pass as every other rule (compiler/retype.py).

Run after compiler/retype.py, before compiler/modality.py:
    python compiler/two_readings.py 5481-504 264-700 264-418 --suffix .union.p2.typed.v3
Labels with no data/text/<reg>.ocr.json are written through unchanged.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from compile_label import PRICES, guard, norm, restore_units, squash  # noqa: E402

COMPILED = ROOT / "data" / "compiled"
TEXT = ROOT / "data" / "text"
INDEX = ROOT / "data" / "labels" / "index.json"
OCR_MODEL = "nvidia/NVIDIA-Nemotron-Parse-2.0"

MARKS = re.compile(r"\^\{[^}]*\}|\\\([^)]*\\\)|[�®™]")
ANCHOR = 20  # characters at each end of the quote used to find it in a reading
CONTEXT = 8  # characters of the quote on each side of a disputed span that the other reading must also contain
MAX_DISPUTED = 0.25  # at most this share of the quote may rest on the second reading alone


def flat(s: str) -> str:
    return squash(norm(MARKS.sub("", s)))


def _confirmed(q: str, primary: str, confirm: str) -> bool:
    """The quote matches `primary` except in spans that `confirm` contains verbatim, with context."""
    if len(q) < 2 * ANCHOR:
        return False
    start = primary.find(q[:ANCHOR])
    if start < 0:
        return False
    end = primary.find(q[-ANCHOR:], start)
    if end < 0:
        return False
    window = primary[start : end + ANCHOR]
    if not 0.8 <= len(window) / len(q) <= 1.3:
        return False
    disputed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, q, window, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        disputed += max(i2 - i1, j2 - j1)
        span = q[max(0, i1 - CONTEXT) : i2 + CONTEXT]
        if span not in confirm:
            return False
    return disputed <= MAX_DISPUTED * len(q)


def check(quote: str, layer_text: str, ocr_text: str) -> str | None:
    """How the quote is confirmed by two readings of its page, or None."""
    q, layer, ocr = flat(quote), flat(layer_text), flat(ocr_text)
    if not q or "..." in q or chr(0x2026) in q:
        return None
    if q in ocr:
        return "ocr"
    if _confirmed(q, layer, ocr):
        return "text layer + ocr"
    if _confirmed(q, ocr, layer):
        return "ocr + text layer"
    return None


def rescue(reg: str, suffix: str, model: str, key: str | None) -> dict:
    src = json.loads((COMPILED / f"{reg}{suffix}.json").read_text(encoding="utf-8"))
    ocr_path = TEXT / f"{reg}.ocr.json"
    if not ocr_path.exists():
        return {**src, "ocr_available": False, "ocr_rescued": 0}
    import retype  # noqa: PLC0415  (only labels with OCR need the typing call)
    from pypdf import PdfReader  # noqa: PLC0415

    ocr = json.loads(ocr_path.read_text(encoding="utf-8"))
    meta = json.loads(INDEX.read_text(encoding="utf-8"))[reg]
    if ocr.get("label_sha256") != meta["sha256"]:
        raise SystemExit(f"{reg}: OCR was made from a different label file ({ocr.get('label_sha256')} != {meta['sha256']})")
    layer = [p.extract_text() or "" for p in PdfReader(ROOT / meta["file"]).pages]
    accepted, rejected, rescued, tin, tout = list(src["accepted"]), [], 0, 0, 0
    for r in src["rejected"]:
        how = None
        if str(r.get("reject_reason", "")).startswith("QUOTE_NOT_IN_PAGE"):
            how = check(r["quote"], layer[r["page"] - 1], ocr["pages"].get(str(r["page"]), ""))
        if how is None:
            rejected.append(r)
            continue
        if key is None:
            raise SystemExit("NEBIUS_API_KEY missing: rescued rules must be typed like every other rule")
        res = retype.call(model, r, key)
        tin += res["usage"].get("prompt_tokens", 0)
        tout += res["usage"].get("completion_tokens", 0)
        base = {k: v for k, v in r.items() if k != "reject_reason"}
        base["quote_check"] = f"{how} ({OCR_MODEL})"
        if not res["ok"]:
            rejected.append({**r, "reject_reason": f"RESCUE_TYPING_FAILED:{res['error'][:80]}"})
            continue
        new = restore_units({**base, **res["typed"], "first_pass_param": r["param"], "typed_by": model, "agreed": res["typed"]["param"] == r["param"]})
        why = guard(new, norm(r["quote"]))  # the quote is its own page here: only the number guard can fail
        if why:
            rejected.append({**r, "reject_reason": f"RESCUED_THEN_{why}"})
            continue
        accepted.append(new)
        rescued += 1
    price = PRICES.get(model, (0, 0))
    return {
        **src,
        "accepted": accepted,
        "rejected": rejected,
        "ocr_available": True,
        "ocr_model": OCR_MODEL,
        "ocr_rescued": rescued,
        "ocr_rescue_cost_usd": round(tin / 1e6 * price[0] + tout / 1e6 * price[1], 4),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--suffix", required=True, help="typed rule file suffix, e.g. .union.p2.typed.v3")
    ap.add_argument("--tag", default=".ocr")
    ap.add_argument("--model", default="nvidia/Nemotron-3-Ultra-550b-a55b")
    a = ap.parse_args()
    key = os.environ.get("NEBIUS_API_KEY", "").strip() or None
    for reg in a.regs:
        out = rescue(reg, a.suffix, a.model, key)
        (COMPILED / f"{reg}{a.suffix}{a.tag}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        if out["ocr_available"]:
            print(f"{reg}: rescued {out['ocr_rescued']} rules with a second reading, ${out['ocr_rescue_cost_usd']}")
            for r in out["accepted"]:
                if "quote_check" in r:
                    print(f"  {r['id']} {r['param']} {r['modality']} [{r['quote_check']}] {r['quote'][:90]}")
        else:
            print(f"{reg}: no OCR file, written through unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
