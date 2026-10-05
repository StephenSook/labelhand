"""OCR a scanned label with NVIDIA Nemotron Parse 2.0 on a GPU (a Nebius AI Cloud Serverless Job, or locally).

Some EPA-accepted labels are scans with a broken text layer (Dropp SC, accepted 2009, extracts as
"less"ti'liln desirable"). This renders each page and reads it with Nemotron Parse 2.0, keeping the text in
the model's reading order. The compiler can then use this text as the page truth (compile_label.py
--text-source ocr), and every rule from it is marked as coming from OCR.

Runs in its own environment (transformers 5.6.1 etc. per the model card). On the local RTX 2070 SUPER (8 GB,
Turing, no bf16) one page's attention needs 10.6 GiB and no memory-efficient kernel accepts the model's inputs, so
the supported path is a Nebius L40S (48 GB) Serverless Job: tools/ocr_job/submit.sh. Default dtype there: bfloat16.

Run: python tools/ocr_parse.py 264-700 [--scale 2.0] [--pages 4 5 6] [--dtype bfloat16] [--attention auto]
Writes data/text/<reg>.ocr.json (gitignored: label text is not redistributed).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import time

import pypdfium2 as pdfium
import torch
from huggingface_hub import snapshot_download
from torch.nn.attention import SDPBackend, sdpa_kernel
from transformers import AutoModel, AutoProcessor, GenerationConfig

ROOT = pathlib.Path(__file__).resolve().parents[1]
INDEX = ROOT / "data" / "labels" / "index.json"
TEXT = ROOT / "data" / "text"
MODEL = "nvidia/NVIDIA-Nemotron-Parse-2.0"
PROMPT = "</s><s><predict_bbox><predict_classes><output_markdown><predict_no_text_in_pic>"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("reg")
    ap.add_argument("--scale", type=float, default=2.0, help="render scale over 72 dpi")
    ap.add_argument("--pages", type=int, nargs="*", help="1-based pages; default all")
    ap.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"], help="bfloat16 on Ampere or newer; Turing has no bf16")
    ap.add_argument("--attention", default="auto", choices=["auto", "efficient"], help="efficient forces the memory-efficient SDPA kernel")
    a = ap.parse_args()

    meta = json.loads(INDEX.read_text(encoding="utf-8"))[a.reg]
    path = snapshot_download(MODEL)
    sys.path.insert(0, path)  # the model repo ships postprocessing.py
    from postprocessing import extract_classes_bboxes, postprocess_text  # type: ignore  # noqa: E402

    dev = "cuda:0" if torch.cuda.is_available() else "cpu"
    t0 = time.time()
    dtype = getattr(torch, a.dtype)
    model = AutoModel.from_pretrained(path, trust_remote_code=True, dtype=dtype).to(dev).eval()  # transformers 5: "dtype", not "torch_dtype"
    processor = AutoProcessor.from_pretrained(path, trust_remote_code=True)
    gen = GenerationConfig.from_pretrained(path, trust_remote_code=True)
    load_s = time.time() - t0

    pdf = pdfium.PdfDocument(str(ROOT / meta["file"]))
    wanted = a.pages or list(range(1, len(pdf) + 1))
    pages, timings = {}, {}
    for n in wanted:
        img = pdf[n - 1].render(scale=a.scale).to_pil().convert("RGB")
        t = time.time()
        inputs = processor(images=[img], text=PROMPT, return_tensors="pt", add_special_tokens=False).to(dev)
        inputs["pixel_values"] = inputs["pixel_values"].to(dtype)
        # "efficient" forces the memory-efficient kernel (needed below about 12 GB of VRAM, and it failed on Turing
        # with "No available kernel"); "auto" lets PyTorch choose, which fits on a 48 GB L40S.
        kernels = [SDPBackend.EFFICIENT_ATTENTION] if a.attention == "efficient" else [SDPBackend.FLASH_ATTENTION, SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]
        with torch.no_grad(), sdpa_kernel(kernels):
            out = model.generate(**inputs, generation_config=gen)
        raw = processor.batch_decode(out, skip_special_tokens=True)[0]
        classes, _, texts = extract_classes_bboxes(raw)
        parts = [postprocess_text(tx, cls=c, table_format="markdown", text_format="plain", blank_text_in_figures=False) for tx, c in zip(texts, classes, strict=False)]
        pages[n] = "\n".join(p for p in parts if p and p.strip())
        timings[n] = round(time.time() - t, 2)
        print(f"page {n}: {len(pages[n])} chars in {timings[n]}s", flush=True)

    TEXT.mkdir(parents=True, exist_ok=True)
    rec = {
        "reg": a.reg,
        "label_sha256": meta["sha256"],
        "model": MODEL,
        "dtype": a.dtype,
        "device": torch.cuda.get_device_name(0) if dev.startswith("cuda") else "cpu",
        "render_scale": a.scale,
        "load_secs": round(load_s, 1),
        "secs_per_page": timings,
        "ocr_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "pages": pages,
    }
    (TEXT / f"{a.reg}.ocr.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    print(f"wrote data/text/{a.reg}.ocr.json | load {load_s:.1f}s | {len(pages)} pages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
