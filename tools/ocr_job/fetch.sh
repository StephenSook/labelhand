#!/usr/bin/env bash
# Decode the OCR result a finished job printed to its log into data/text/<reg>.ocr.json (gitignored).
# Usage: bash tools/ocr_job/fetch.sh <job-id> 264-700
set -euo pipefail
JOB="${1:?job id}"; REG="${2:?registration number}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
NEBIUS="${NEBIUS:-$HOME/.nebius/bin/nebius}"
LOG="$(mktemp)"; trap 'rm -f "$LOG"' EXIT
# `nebius ai logs` returns only the last 100 lines unless --tail is given (maximum 1000), which cut the base64 block
# in half on the first real run (END marker present, BEGIN marker gone). Ask for the maximum and require both markers.
"$NEBIUS" ai logs "$JOB" --since 168h --tail 1000 > "$LOG"
grep -q "=== OCR_JSON_BEGIN $REG" "$LOG" && grep -q "=== OCR_JSON_END $REG" "$LOG" || { echo "no complete OCR block for $REG in the last 1000 log lines"; exit 1; }
mkdir -p "$ROOT/data/text"
OUT="$ROOT/data/text/$REG.ocr.json"
sed -n "/=== OCR_JSON_BEGIN $REG/,/=== OCR_JSON_END $REG/p" "$LOG" | sed '1d;$d' | base64 -d | gunzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"  # only a fully decoded file replaces the previous one
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['reg'], d['device'], len(d['pages']), 'pages', d['secs_per_page'])" "$ROOT/data/text/$REG.ocr.json"
