#!/usr/bin/env bash
# Runs inside the Nebius Serverless Job container. Fetches the label PDF from EPA, checks its sha256 against the
# index, OCRs it with Nemotron Parse 2.0, and prints the result between markers (gzip + base64) for fetch.sh.
set -euo pipefail
REG="$1"
mkdir -p /work/tools /work/data/labels /work/data/text
cp /inject/ocr_parse.py /work/tools/
cp /inject/index.json /work/data/labels/
# The pytorch 2.11 image's system Python is marked externally managed (PEP 668), so a plain pip install exits with
# "externally-managed-environment" before anything runs (first job, 2026-10-05). The container is thrown away
# after one run, so installing into the system environment is safe here.
export PIP_BREAK_SYSTEM_PACKAGES=1
pip install --quiet --no-cache-dir transformers==5.6.1 accelerate==1.12.0 timm==1.0.22 open_clip_torch==3.2.0 \
  einops==0.8.1 pypdfium2==5.14.0 huggingface_hub==1.33.0 tokenizers==0.22.2 safetensors==0.8.0 pillow==12.3.0 \
  beautifulsoup4==4.15.0 soupsieve==2.10 torchvision==0.26.0
# beautifulsoup4: the model repo's postprocessing.py imports latex2html, which imports bs4 (second job died on
# "No module named 'bs4'"). torchvision 0.26.0 pairs with the image's torch 2.11.0, so pip never replaces torch.
cd /work
python - "$REG" <<'PY'
import hashlib, json, sys, urllib.request
reg = sys.argv[1]
meta = json.load(open("data/labels/index.json"))[reg]
req = urllib.request.Request(meta["url"], headers={"User-Agent": "labelhand-ocr-job (github.com/StephenSook/labelhand)"})
data = urllib.request.urlopen(req, timeout=120).read()
assert data[:5] == b"%PDF-", "not a PDF (WAF page?)"
digest = hashlib.sha256(data).hexdigest()
assert digest == meta["sha256"], f"sha256 {digest} != index {meta['sha256']}"
open(meta["file"], "wb").write(data)
print(f"label {reg}: {len(data)} bytes, sha256 ok", flush=True)
PY
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python tools/ocr_parse.py "$REG" --dtype bfloat16 --attention auto
echo "=== OCR_JSON_BEGIN $REG"
gzip -c "data/text/$REG.ocr.json" | base64 -w 76
echo "=== OCR_JSON_END $REG"
