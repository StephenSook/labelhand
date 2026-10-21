"""The earlier label version is compiled by the shipped pipeline, step for step, and never writes over the shipped files."""

from __future__ import annotations

import json

import compile_label
import merge_runs
import modality
import previous_compile
import pytest
import retype
import two_readings
import union


def _versions(*dates: str) -> list[dict]:
    return [{"accepted": d, "url": f"https://www3.epa.gov/pesticides/chem_search/ppls/000228-00653-{d.replace('-', '')}.pdf"} for d in dates]


def test_previous_version_is_the_one_accepted_just_before_the_shipped_one():
    versions = _versions("2026-01-02", "2021-05-14", "2021-01-27", "2019-08-23")
    assert previous_version_date(versions, "2021-05-14") == "2021-01-27"
    # A newer label than the shipped one does not count as "previous".
    assert previous_version_date(versions, "2026-01-02") == "2021-05-14"
    assert previous_compile.previous_version(versions, "2019-08-23") is None


def previous_version_date(versions: list[dict], shipped: str) -> str:
    found = previous_compile.previous_version(versions, shipped)
    assert found is not None
    return found["accepted"]


def test_a_shipped_label_ppls_no_longer_lists_stops_the_compile():
    with pytest.raises(RuntimeError, match="does not list the shipped label"):
        previous_compile.previous_version(_versions("2021-01-27"), "2021-05-14")


def test_text_gate_refuses_a_scan_and_accepts_a_label_with_two_blank_cover_pages():
    text = "Do not apply when wind speeds exceed 10 mph. " * 3
    assert previous_compile.readable_text([""] * 11) == "11 of 11 pages have no readable text layer; the PDF is a scan."
    # FreeFall SC accepted 2021-01-27: 13 pages, the first two are images of EPA's letter.
    assert previous_compile.readable_text(["", ""] + [text] * 11) is None
    assert "unreadable text layer" in previous_compile.readable_text([text, chr(0xFFFD) * 5 + "abc"])


def test_steps_repeat_the_shipped_commands_exactly():
    plan = previous_compile.steps("228-653")
    assert plan[:6] == [
        ("compile_label", ["228-653", "--tag", ".p2"]),
        ("compile_label", ["228-653", "--model", "nvidia/Nemotron-3-Ultra-550b-a55b", "--tag", ".p2"]),
        ("union", ["228-653", "--passes", ".p2", ".Nemotron-3-Ultra-550b-a55b.p2", "--tag", ".p2"]),
        ("retype", ["228-653", "--suffix", ".union.p2", "--tag", ".v3"]),
        ("two_readings", ["228-653", "--suffix", ".union.p2.typed.v3"]),
        ("modality", ["228-653", "--suffix", ".union.p2.typed.v3.ocr", "--tag", ".mf"]),
    ]
    assert [argv[2] for name, argv in plan if name == "compile_label" and len(argv) == 3] == [".p2", ".p2r2", ".p2r3"]
    assert plan[-1] == ("merge_runs", ["228-653"])
    # The merge reads exactly the three files the runs end with, as the shipped merge did.
    assert merge_runs.DEFAULT_RUNS == [f".union{tag}.typed.v3.ocr.mf" for tag in previous_compile.RUNS]


def test_sandbox_moves_every_path_the_steps_use_and_restores_them(tmp_path):
    shipped = {
        "compile_label": (compile_label.INDEX, compile_label.OUT),
        "union": union.COMPILED,
        "retype": retype.COMPILED,
        "two_readings": (two_readings.COMPILED, two_readings.INDEX, two_readings.TEXT),
        "modality": (modality.COMPILED, modality.INDEX),
        "merge_runs": merge_runs.COMPILED,
    }
    index = tmp_path / "index.json"
    with previous_compile.sandbox(tmp_path, index):
        assert (compile_label.INDEX, compile_label.OUT) == (index, tmp_path)
        assert union.COMPILED == retype.COMPILED == two_readings.COMPILED == modality.COMPILED == merge_runs.COMPILED == tmp_path
        assert two_readings.INDEX == modality.INDEX == index
        assert not two_readings.TEXT.exists()  # no OCR file, as for the shipped runs of these labels
    assert shipped == {
        "compile_label": (compile_label.INDEX, compile_label.OUT),
        "union": union.COMPILED,
        "retype": retype.COMPILED,
        "two_readings": (two_readings.COMPILED, two_readings.INDEX, two_readings.TEXT),
        "modality": (modality.COMPILED, modality.INDEX),
        "merge_runs": merge_runs.COMPILED,
    }


def _fake_step(out_dir, calls, cost=0.1):
    """Write each step's file the way the real step names it, so run_cost and the merge can read them."""

    def step(name, argv):
        calls.append((name, argv))
        # The step must see the sandbox, never the shipped folder.
        assert compile_label.OUT == out_dir and merge_runs.COMPILED == out_dir
        reg = argv[0]
        if name == "compile_label":
            model_tag = "" if "--model" not in argv else ".Nemotron-3-Ultra-550b-a55b"
            (out_dir / f"{reg}{model_tag}{argv[-1]}.json").write_text(json.dumps({"cost_usd": cost}), encoding="utf-8")
        if name == "modality":
            run = argv[2].split(".")[2]
            (out_dir / f"{reg}.union.{run}.typed.v3.ocr.mf.json").write_text(json.dumps({"retype_cost_usd": cost, "ocr_rescue_cost_usd": 0.0}), encoding="utf-8")

    return step


def test_compile_runs_every_step_in_the_sandbox_and_sums_each_runs_cost(tmp_path):
    calls: list = []
    runs = previous_compile.compile_previous("228-653", tmp_path, tmp_path / "index.json", 0.0, 4.0, 0.2, step=_fake_step(tmp_path, calls))
    assert calls == previous_compile.steps("228-653")
    assert [r["run"] for r in runs] == [".p2", ".p2r2", ".p2r3"]
    assert all(r["total_usd"] == pytest.approx(0.3) for r in runs)


def test_budget_stops_before_a_run_that_could_pass_it(tmp_path):
    calls: list = []
    runs: list = []
    with pytest.raises(previous_compile.BudgetStop, match="run .p2r2"):
        previous_compile.compile_previous("228-653", tmp_path, tmp_path / "index.json", 3.5, 4.0, 0.2, step=_fake_step(tmp_path, calls), runs=runs)
    # The run that finished before the stop was paid for, so the caller still sees it.
    assert [r["run"] for r in runs] == [".p2"]
    # The first run fit ($3.5 + $0.2 estimate); after it cost $0.3, a second $0.3 run would pass $4.
    assert [argv[-1] for name, argv in calls if name == "compile_label"] == [".p2", ".p2"]
    assert not any(name == "merge_runs" for name, _ in calls)
