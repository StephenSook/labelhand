"""Fetch the newest EPA-accepted label PDF for each EPA registration number from PPLS.

PPLS (Pesticide Product Label System) lists every accepted label version for a registration
number. This tool reads that list, downloads the newest PDF, verifies it is really a PDF
(magic bytes and a minimum size, because government sites can answer a block page with
HTTP 200), and records product name, accepted date, URL and SHA-256 in data/labels/index.json.

The same function backs the nightly label-watch job: a changed SHA-256 or a newer accepted
date means the label must be recompiled.

Usage: python tools/ppls_fetch.py 5481-504 264-700 ...
"""

from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import pathlib
import re
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
LABELS = ROOT / "data" / "labels"
INDEX = LABELS / "index.json"
UA = "labelhand-research/0.1 (github.com/StephenSook)"
PAGE = "https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:{reg}"
JSON_API = "https://ordspub.epa.gov/ords/pesticides/cswu/ppls/{reg}"
PDF_RE = re.compile(r"chem_search/ppls/(\d{6})-(\d{5})-(\d{8})\.pdf")
# Fields a person writes into index.json by hand; a re-fetch must keep them.
CURATED = ("shortName",)


def merge_record(prev: dict | None, rec: dict) -> dict:
    """Return the fetched record plus any hand-curated fields from the previous entry."""
    kept = {key: prev[key] for key in CURATED if prev and key in prev}
    return {**rec, **kept}


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _versions_from_files(reg: str, files: list[str]) -> list[dict]:
    """Label versions of exactly this registration, newest first, from PPLS PDF file names."""
    company, product = (int(x) for x in reg.split("-"))
    versions = []
    for co, pr, ymd in (match for name in files for match in PDF_RE.findall(f"chem_search/ppls/{name}")):
        if int(co) != company or int(pr) != product:
            continue  # PPLS also lists labels from earlier registrations of the same brand
        versions.append({"accepted": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}", "url": f"https://www3.epa.gov/pesticides/chem_search/ppls/{co}-{pr}-{ymd}.pdf"})
    versions.sort(key=lambda v: v["accepted"], reverse=True)
    return versions


def parse_ppls_json(reg: str, payload: dict) -> tuple[str, list[dict]]:
    """Read PPLS's JSON product record (the cswu API) into (product name, versions newest first)."""
    items = payload.get("items") or []
    record = next((item for item in items if item.get("eparegno") == reg), None)
    if record is None:
        raise RuntimeError(f"PPLS JSON has no record for {reg}")
    files = [entry.get("pdffile", "") for entry in record.get("pdffiles") or []]
    return str(record.get("productname") or "").strip(), _versions_from_files(reg, files)


def list_versions(reg: str) -> tuple[str, list[dict]]:
    """Return (product name, versions newest first) for one registration number.

    The PPLS HTML page often drops connections, so its JSON API is tried next, a few times.
    Both list the same PDF files; only an answer that names this registration is used.
    """
    try:
        page = html.unescape(_get(PAGE.format(reg=reg)).decode("utf-8", "replace"))
        files = [f"{co}-{pr}-{ymd}.pdf" for co, pr, ymd in PDF_RE.findall(page)]
        m = re.search(rf"{re.escape(reg)}\s*</td>\s*<td[^>]*>\s*([^<]+?)\s*</td>", page)
        name = (m.group(1) if m else "").replace(chr(0xFFFD), "").strip()
        return name, _versions_from_files(reg, files)
    except OSError as page_error:
        last: Exception = page_error
    for attempt in range(6):
        try:
            return parse_ppls_json(reg, json.loads(_get(JSON_API.format(reg=reg), timeout=45)))
        except (OSError, ValueError, RuntimeError) as error:
            last = error
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"PPLS HTML and JSON both failed for {reg}: {type(last).__name__}: {last}")


def fetch(reg: str) -> dict:
    name, versions = list_versions(reg)
    if not versions:
        raise RuntimeError(f"PPLS listed no label PDFs for {reg}; nothing fetched")
    newest = versions[0]
    body = _get(newest["url"], timeout=120)
    if not body.startswith(b"%PDF-") or len(body) < 20_000:
        raise RuntimeError(f"{newest['url']} did not return a PDF ({len(body)} bytes, starts {body[:8]!r})")
    LABELS.mkdir(parents=True, exist_ok=True)
    path = LABELS / pathlib.Path(newest["url"]).name
    path.write_bytes(body)
    return {
        "reg": reg,
        "product": name,
        "accepted": newest["accepted"],
        "url": newest["url"],
        "file": str(path.relative_to(ROOT)).replace("\\", "/"),
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "versions_listed": len(versions),
        "fetched_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }


def main(regs: list[str]) -> int:
    index = json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.exists() else {}
    failed = 0
    for reg in regs:
        try:
            rec = fetch(reg)
            prev = index.get(reg)
            changed = prev is None or prev.get("sha256") != rec["sha256"]
            index[reg] = merge_record(prev, rec)
            print(f"{reg} {rec['product']!r} accepted {rec['accepted']} {rec['bytes']} bytes sha256 {rec['sha256'][:12]} {'NEW/CHANGED' if changed else 'unchanged'}")
        except Exception as e:  # a failed fetch is reported, never recorded as "no label"
            failed += 1
            print(f"{reg} FAILED: {type(e).__name__}: {e}")
        time.sleep(3)  # be polite to EPA
    if failed < len(regs):  # nothing fetched means nothing to record; leave the index untouched
        INDEX.parent.mkdir(parents=True, exist_ok=True)
        INDEX.write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8", newline="\n")
    return 1 if failed == len(regs) else (2 if failed else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["5481-504", "264-700"]))
