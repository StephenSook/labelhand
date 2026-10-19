"""Validate the committed photo-reading evaluation receipt."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RESULT = ROOT / "eval" / "results" / "photo-read-2026-10-19.json"
MODEL = "nvidia/Nemotron-3.5-Super-VL"
REQUIRED = {
    "5481-504",
    "264-700",
    "264-418",
    "100-1256",
    "264-802",
    "62719-643",
    "279-9583",
}


def load_result() -> dict:
    return json.loads(RESULT.read_text(encoding="utf-8"))


def test_photo_eval_uses_the_declared_real_label_sample() -> None:
    result = load_result()
    manifest = result["manifest"]
    labels = result["labels"]

    assert result["run"]["status"] == "complete"
    assert result["data_description"] == ("These inputs are rendered label pages and rendered pages with simulated phone degradation. They are not photos.")
    assert result["model_availability"]["model_present"] is True
    assert result["model_availability"]["model"] == MODEL
    assert result["model_availability"]["matched_model"]["id"] == MODEL
    assert result["input_sets"] == {
        "rendered_label_pages": {
            "images": 20,
            "source": "newest accepted EPA PPLS PDF front-panel page",
            "long_side_px": 1600,
            "jpeg_quality": 90,
        },
        "simulated_phone_degradation": {
            "images": 20,
            "source": "same rendered label page",
            "rotation_degrees": 4,
            "crop_percent": 6,
            "crop_rule": "crop the edge opposite the registration number",
            "long_side_px": 1600,
            "jpeg_quality": 55,
        },
    }
    assert len(manifest) == len(labels) == 20
    assert {item["reg"] for item in manifest if item["required"]} == REQUIRED
    assert sum(not item["required"] for item in manifest) == 13
    assert {item["reg"] for item in manifest} == {item["reg"] for item in labels}
    assert all(item["newest_url"].startswith("https://www3.epa.gov/pesticides/chem_search/ppls/") for item in labels)
    assert all(item["front_panel_page"] > 0 for item in labels)
    assert all(len(item["pdf_sha256"]) == 64 and item["pdf_bytes"] > 0 for item in labels)


def test_photo_eval_images_and_pooled_metrics_recompute() -> None:
    result = load_result()
    images = result["images"]
    pooled = result["pooled"]
    labels = {item["reg"]: item for item in result["labels"]}

    assert pooled["labels_evaluated"] == 20
    assert pooled["expected_images"] == pooled["completed_images"] == len(images) == 40
    assert pooled["failed_images"] == 0
    assert Counter(image["reg_truth"] for image in images) == Counter({reg: 2 for reg in labels})
    assert Counter(image["set"] for image in images) == {
        "rendered_label_pages": 20,
        "simulated_phone_degradation": 20,
    }

    for image in images:
        label = labels[image["reg_truth"]]
        assert image["status"] == "completed"
        assert image["label_sha256"] == label["pdf_sha256"]
        assert image["front_panel_page"] == label["front_panel_page"]
        assert len(image["image_sha256"]) == 64 and image["image_bytes"] > 0
        assert image["usage"]["totalTokens"] == (image["usage"]["inputTokens"] + image["usage"]["outputTokens"])
        assert image["usage"]["costUsd"] >= 0
        assert image["latency_ms"] > 0
        if image["set"] == "rendered_label_pages":
            assert image["transform"]["long_side_px"] == 1600
            assert image["transform"]["jpeg_quality"] == 90
        else:
            assert image["transform"]["rotation_degrees"] == 4
            assert image["transform"]["crop_percent"] == 6
            assert image["transform"]["long_side_px"] == 1600
            assert image["transform"]["jpeg_quality"] == 55

    for set_name, expected_images in (
        ("rendered_label_pages", [image for image in images if image["set"] == "rendered_label_pages"]),
        (
            "simulated_phone_degradation",
            [image for image in images if image["set"] == "simulated_phone_degradation"],
        ),
        ("overall", images),
    ):
        summary = pooled["overall"] if set_name == "overall" else pooled["sets"][set_name]
        exact = sum(image["exact_reg_match"] for image in expected_images)
        names = sum(image["product_name_agrees"] is True for image in expected_images)
        assert summary["images"] == len(expected_images)
        assert summary["exact_reg_reads"] == exact
        assert summary["exact_reg_read_rate"] == pytest.approx(exact / len(expected_images))
        assert summary["product_name_agreements"] == names
        assert summary["product_name_agreement_rate"] == pytest.approx(names / len(expected_images))
        assert summary["verdict_counts"] == dict(Counter(image["verdict"] for image in expected_images))

    wrong_but_valid = [
        image for image in images if image["read_epa_reg_no"] != image["reg_truth"] and image["read_epa_reg_no"] is not None and image["verdict"] not in {"NOT_FOUND", "UNREADABLE"}
    ]
    assert pooled["wrong_but_valid_reg_reads"] == len(wrong_but_valid)
    assert pooled["wrong_but_valid_cases"] == []
    assert result["run"]["current_run_cost_usd"] == pytest.approx(pooled["overall"]["cost_usd"])
    prior_spend = sum(run["cost_usd"] for run in result["run"]["prior_paid_runs"])
    assert result["run"]["total_session_cost_usd"] == pytest.approx(prior_spend + result["run"]["current_run_cost_usd"])
