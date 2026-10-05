#!/usr/bin/env bash
# Submit the OCR job to Nebius AI Cloud Serverless Jobs (run in WSL after `nebius profile create`).
# Usage: bash tools/ocr_job/submit.sh 264-700 [--dry-run]
set -euo pipefail
REG="${1:?registration number, e.g. 264-700}"; shift || true
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
NEBIUS="${NEBIUS:-$HOME/.nebius/bin/nebius}"
IMAGE="pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime@sha256:eee11b3b3872a8c838e35ef48f08b2d5def2080902c7f666831310ca1a0ef2be"
"$NEBIUS" ai job create \
  --name "labelhand-ocr-$REG-$(date -u +%Y%m%d%H%M)" \
  --image "$IMAGE" \
  --parent-id "${NEBIUS_PROJECT_EU_NORTH1:-project-e00mwywjpr00x87mxbjn98}" \
  --platform gpu-l40s-a \
  --preset 1gpu-8vcpu-32gb \
  --timeout 1h \
  --disk-size 100Gi \
  --inject-file "$ROOT/tools/ocr_parse.py:/inject/ocr_parse.py" \
  --inject-file "$ROOT/data/labels/index.json:/inject/index.json" \
  --inject-file "$HERE/run.sh:/inject/run.sh" \
  --container-command bash \
  --args "/inject/run.sh $REG" \
  "$@"
