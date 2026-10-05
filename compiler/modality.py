"""Modality floor in code, from EPA's own rule for mandatory and advisory label statements.

EPA's Pesticide Labeling Questions & Answers quotes PR Notice 2000-5 (read 2026-10-05,
https://www.epa.gov/pesticide-labels/pesticide-labeling-questions-answers):

    "Mandatory statements are generally written in imperative or directive terms (such as "shall," "must,"
    "do this," "do not") so that a typical user will understand that these statements direct the user to take
    or avoid certain actions, and that failure to follow these instructions is a misuse of the product.
    Advisory statements are generally best written in descriptive or nondirective terms ... Suggestive terms
    such as "should," "may" or "recommend" ..."

The same notice warns that a heading sets intent ("A set of mandatory directions preceded by an advisory heading
such as "Use Recommendations" potentially conflicts with the nature of the intended action"), and labels print
EPA's standard drift text in two parts: MANDATORY SPRAY DRIFT MANAGEMENT and SPRAY DRIFT ADVISORIES.

The typing model does not always follow the rule. Folex's "When minimum night temperature is below 60F use
FOLEX 6 EC alone" is an imperative that gates the application, and Nemotron 3 Ultra typed it MUST in one run and
ADVISORY in all three votes of another. A missed limit can mark a forbidden hour as permitted, so code raises
an ADVISORY rule to acting when all of these hold, and never lowers a modality:

1. the rule's parameter is one the planner can act on (wind, inversion, rain, air or night temperature);
2. the quote is not inside an advisory section of the label (SPRAY DRIFT ADVISORIES and its standard
   subheadings, or any heading that says ADVISORY or RECOMMENDATIONS);
3. a sentence of the quote with no suggestive term is a prohibition ("do not", "must not", "never": MUST_NOT),
   or a directive ("must", "shall", or an imperative verb opening the sentence or its main clause) that gates
   the application itself: apply, spray, release, or use the product ("use FOLEX 6 EC alone"). "Applicators
   must use 1/2 swath displacement" is mandatory but is a technique, not a weather limit, so it stays as typed.

A raised rule keeps the model's answer in modality_model and the reason in modality_floor.

Run after compiler/retype.py (no API calls; needs the label PDFs that tools/ppls_fetch.py downloads):
    python compiler/modality.py 5481-504 264-700 264-418 --suffix .union.p2.typed.v3 --tag .mf
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "engine"))
from compile_label import norm, squash  # noqa: E402
from windows import TOPIC  # noqa: E402  (the parameters the planner can act on)

COMPILED = ROOT / "data" / "compiled"
INDEX = ROOT / "data" / "labels" / "index.json"
SOURCE = "EPA PR Notice 2000-5: mandatory statements are written in imperative or directive terms"

# Suggestive terms. Long ones are matched with spaces removed, because PDF text layers split words
# ("highly re commended").
SUGGESTIVE_WORDS = re.compile(r"\b(should|may|might|ideally|preferably|preferred|optional)\b")
SUGGESTIVE_STEMS = ("recommend", "suggest", "optimum", "optimal", "bestresults", "forbest")
PROHIBITION = re.compile(r"\b(do not|don't|must not|shall not|never)\b")
DIRECTIVE = re.compile(r"\b(must|shall)\b")
# Verbs that open label directions. "avoid" is left out on purpose: EPA's label review training says it "may be
# seen as only advisory by some users".
VERBS = (
    "use|apply|spray|mix|add|wait|allow|keep|remove|maintain|select|make|begin|observe|follow|calibrate|adjust|"
    "read|wear|rinse|clean|notify|check|monitor|limit|restrict|treat|incorporate|defoliate|release|hold|delay|"
    "consult|agitate|fill|leave|postpone|stop|cease|wash|store|dispose"
)
OPENING = re.compile(rf"^(?:only\s+|always\s+|then\s+)?(?:{VERBS})\b(?!\s+of\b)")
CONDITION = re.compile(r"^(when|if|where|before|after|unless|once|while|until)\b")
# After a condition, the main clause starts after a comma, a number, a unit or a closing parenthesis.
MAIN_CLAUSE = re.compile(rf"(?:,|\d|\bf\b|%|\)|\bmph\b|\binches\b|\bfeet\b|\bhours?\b|\bdays?\b)\s+(?:only\s+)?(?:{VERBS})\b(?!\s+of\b)")
APPLICATION_VERBS = re.compile(r"\b(apply|applying|applied|application|applications|spray|release|treat)\b")

# Headings that open an advisory section, and the standard subheadings EPA's drift advisory text uses under it.
ADVISORY_HEADING = re.compile(r"advisor|recommendation")
ADVISORY_SUBHEADINGS = (
    "the applicator is responsible",
    "importance of droplet size",
    "controlling droplet size",
    "boom height",
    "boom length",
    "release height",
    "application height",
    "swath adjustment",
    "shielded sprayers",
    "temperature and humidity",
    "temperature inversions",
    "wind",
    "sensitive areas",
    "volume",
    "pressure",
    "nozzle",
    "number of nozzles",
    "adjust nozzles",
)


def sentences(text: str) -> list[str]:
    return [s.strip(" -*:") for s in re.split(r"(?<=[.;!?])\s+", text) if s.strip(" -*:")]


def suggestive(sentence: str) -> bool:
    flat = squash(sentence)
    return bool(SUGGESTIVE_WORDS.search(sentence)) or any(stem in flat for stem in SUGGESTIVE_STEMS)


def gates_application(sentence: str, brand: str | None) -> bool:
    if APPLICATION_VERBS.search(sentence):
        return True
    targets = ["this product", "the product"] + ([brand] if brand else [])
    return any(re.search(rf"\buse\s+(?:only\s+)?{re.escape(t)}\b", sentence) for t in targets)


def floor_of(quote: str, brand: str | None = None) -> str | None:
    """The lowest modality EPA's rule allows for this quote: MUST_NOT, MUST, or None (no floor)."""
    best = None
    for s in sentences(norm(quote).replace(chr(0xB0), " ")):
        if suggestive(s):
            continue
        if PROHIBITION.search(s):
            return "MUST_NOT"
        directive = DIRECTIVE.search(s) or OPENING.search(s) or (CONDITION.search(s) and MAIN_CLAUSE.search(s))
        if directive and gates_application(s, brand):
            best = "MUST"
    return best


def is_heading(line: str) -> bool:
    s = line.strip()
    letters = [c for c in s if c.isalpha()]
    return 4 <= len(letters) and len(s) <= 90 and sum(c.isupper() for c in letters) >= 0.9 * len(letters)


def in_advisory_section(pages: list[str], page_no: int, quote: str) -> bool | None:
    """Whether the quote sits under an advisory heading. None when the quote cannot be found on its page."""
    advisory = False
    target = squash(norm(quote))[:60]
    for n, text in enumerate(pages[:page_no], start=1):
        lines = text.splitlines()
        if n == page_no:
            flat = [squash(norm(line)) for line in lines]
            joined = "".join(flat)
            at = joined.find(target)
            if at < 0:
                return None
            end, cut = 0, len(lines)
            for i, piece in enumerate(flat):
                end += len(piece)
                if end > at:
                    cut = i
                    break
            lines = lines[:cut]
        for line in lines:
            if not is_heading(line):
                continue
            h = norm(line)
            if ADVISORY_HEADING.search(h):
                advisory = True
            elif advisory and not any(h.startswith(sub) for sub in ADVISORY_SUBHEADINGS):
                advisory = False
    return advisory


def apply_floor(rule: dict, pages: list[str] | None, brand: str | None) -> dict:
    if rule.get("modality") != "ADVISORY" or rule.get("param") not in TOPIC:
        return rule
    floor = floor_of(rule.get("quote", ""), brand)
    if floor is None:
        return rule
    section = in_advisory_section(pages, rule["page"], rule["quote"]) if pages else None
    if section is not False:
        return rule  # inside an advisory section, or the section could not be checked: leave the model's answer
    return {**rule, "modality": floor, "modality_model": "ADVISORY", "modality_floor": SOURCE}


def brand_of(product: str) -> str | None:
    words = re.findall(r"[a-z0-9]+", norm(product))
    return words[0] if words else None


def label_pages(reg: str) -> tuple[list[str], str | None]:
    from pypdf import PdfReader

    meta = json.loads(INDEX.read_text(encoding="utf-8"))[reg]
    pages = [p.extract_text() or "" for p in PdfReader(ROOT / meta["file"]).pages]
    return pages, brand_of(meta.get("product", ""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("regs", nargs="+")
    ap.add_argument("--suffix", required=True, help="typed rule file suffix, e.g. .union.p2.typed.v3")
    ap.add_argument("--tag", default=".mf")
    a = ap.parse_args()
    for reg in a.regs:
        src = json.loads((COMPILED / f"{reg}{a.suffix}.json").read_text(encoding="utf-8"))
        pages, brand = label_pages(reg)
        accepted = [apply_floor(r, pages, brand) for r in src["accepted"]]
        raised = [r for r in accepted if "modality_floor" in r]
        out = {**src, "accepted": accepted, "modality_floor_source": SOURCE, "modality_floor_raised": len(raised)}
        (COMPILED / f"{reg}{a.suffix}{a.tag}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        print(f"{reg}: {len(raised)} of {len(accepted)} rules raised from ADVISORY")
        for r in raised:
            print(f"  {r['id']} {r['param']} -> {r['modality']} | {r['quote'][:110]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
