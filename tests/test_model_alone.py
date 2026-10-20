"""Model-alone tests use small records derived from committed engine fixtures."""

from __future__ import annotations

import copy
import datetime as dt
import json
import pathlib

import model_alone

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "engine" / "worth.json"


def fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_prompt_contains_tagged_pages_states_and_forecast_without_compiled_rules():
    data = fixture()
    periods = data["periods"][:2]
    pages = {registration: {} for registration in model_alone.REGISTRATIONS}
    for rule in data["rules"]:
        page = pages[rule["reg"]].setdefault(
            rule["page"],
            [{"reading": "fixture-rules", "text": ""}],
        )
        page[0]["text"] += rule["quote"] + "\n"
    prompt = model_alone.build_prompt(pages, periods)

    for registration in model_alone.REGISTRATIONS:
        assert f"[LABEL registration={registration}" in prompt
    assert data["rules"][0]["quote"] in prompt
    assert "PERMITTED: Every rule of every product in the tank is satisfied" in prompt
    assert "FIELD_CHECK (the forecast cannot decide)" in prompt
    assert periods[0]["startTime"] in prompt
    assert "wind direction" in prompt
    assert "NOT RECORDED" in prompt
    assert data["rules"][0]["id"] not in prompt


def test_prompt_and_schema_do_not_depend_on_model():
    data = fixture()
    periods = data["periods"][:2]
    pages = {registration: {} for registration in model_alone.REGISTRATIONS}
    for rule in data["rules"]:
        page = pages[rule["reg"]].setdefault(rule["page"], [{"reading": "fixture-rules", "text": ""}])
        page[0]["text"] += rule["quote"] + "\n"

    prompt = model_alone.build_prompt(pages, periods)
    bodies = [model_alone.request_body(prompt, model) for model in model_alone.PRICES]
    for body, model in zip(bodies, model_alone.PRICES, strict=True):
        assert body["model"] == model
        assert body["messages"] == bodies[0]["messages"]
        assert body["response_format"] == bodies[0]["response_format"]
        assert body["temperature"] == 0
        assert body["chat_template_kwargs"] == {"enable_thinking": False}


def test_preregistration_records_selected_model_and_budget():
    model = "nvidia/Nemotron-3-Ultra-550b-a55b"
    receipt = model_alone.preregistration("2026-10-19T00:00:00+00:00", model, 2.5)

    assert receipt["model_alone"]["model"] == model
    assert receipt["budget"]["maximum_usd"] == 2.5


def test_public_summary_records_selected_model_and_receipt_source():
    result = {
        "schema_version": 1,
        "preregistration": {"model_alone": {"model": "nvidia/Nemotron-3_5-Lightning"}},
        "run": {"finished_utc": "2026-10-19T00:00:00+00:00", "status": "complete"},
        "summary": {"unsafe_go": [], "lost_window": [], "hours_compared": 1},
    }

    summary = model_alone.public_summary(result, "eval/results/lightning.json")

    assert summary["model"] == "nvidia/Nemotron-3_5-Lightning"
    assert summary["source"] == "eval/results/lightning.json"


def test_sample_selection_picks_first_recording_after_seven_and_ignores_earlier_recording():
    data = fixture()
    original = dt.datetime.fromisoformat(data["forecast_fetched_utc"])
    day = original.astimezone(model_alone.LOCAL_ZONE).date()
    first = dt.datetime.combine(day, dt.time(7, 1), model_alone.LOCAL_ZONE)
    before = dt.datetime.combine(day, dt.time(6, 59), model_alone.LOCAL_ZONE)
    later = dt.datetime.combine(day, dt.time(8), model_alone.LOCAL_ZONE)
    noon = dt.datetime.combine(day, dt.time(12), model_alone.LOCAL_ZONE)
    next_day = first + dt.timedelta(days=1)

    def issuance(fetched: dt.datetime, name: str) -> dict:
        return {
            "fetched": fetched,
            "fetched_utc": fetched.astimezone(dt.UTC).isoformat(),
            "periods": copy.deepcopy(data["periods"]),
            "path": name,
        }

    selected = model_alone.select_morning_issuance(
        [
            issuance(noon, "noon"),
            issuance(later, "later"),
            issuance(before, "before"),
            issuance(next_day, "next-day"),
            issuance(first, "first"),
        ],
        day,
    )
    assert selected is not None
    assert selected["path"] == "first"
    assert (
        model_alone.select_morning_issuance(
            [issuance(before, "before"), issuance(noon, "noon"), issuance(next_day, "next-day")],
            day,
        )
        is None
    )


def test_metrics_count_unsafe_go_lost_window_and_verbatim_quotes():
    data = fixture()
    blocked_index = next(index for index, hour in enumerate(data["expected"]) if hour["state"] == "BLOCKED")
    permitted_index = next(index for index, hour in enumerate(data["expected"]) if hour["state"] == "PERMITTED")
    indices = [blocked_index, permitted_index]
    periods = [data["periods"][index] for index in indices]
    planner_hours = [data["expected"][index] for index in indices]
    block = planner_hours[0]["blocked"][0]
    cited_rule = next(rule for rule in data["rules"] if (rule["product"], rule["id"], rule["quote"]) == (block["product"], block["rule"], block["quote"]))
    decoy_rule = {
        **cited_rule,
        "param": "temperature_inversion",
        "quote": next(rule["quote"] for rule in data["rules"] if rule["quote"] != cited_rule["quote"]),
    }
    model_hours = [
        {
            "hour_index": 0,
            "start_time": dt.datetime.fromisoformat(periods[0]["startTime"]).astimezone(model_alone.LOCAL_ZONE).isoformat(),
            "state": "PERMITTED",
            "reason": "The model allowed this recorded hour.",
            "registration": cited_rule["reg"],
            "page": cited_rule["page"],
            "label_sentence": cited_rule["quote"],
        },
        {
            "hour_index": 1,
            "start_time": dt.datetime.fromisoformat(periods[1]["startTime"]).astimezone(model_alone.LOCAL_ZONE).isoformat(),
            "state": "BLOCKED",
            "reason": "The model blocked this recorded hour.",
            "registration": cited_rule["reg"],
            "page": cited_rule["page"],
            "label_sentence": "This sentence is not on the cited page.",
        },
    ]
    pages = {registration: {} for registration in model_alone.REGISTRATIONS}
    pages[cited_rule["reg"]][cited_rule["page"]] = [{"reading": "text-layer", "text": cited_rule["quote"]}]

    metrics, details = model_alone.compute_case_metrics(
        point=data["point"],
        date_local="2026-10-05",
        periods=periods,
        model_hours=model_hours,
        planner_hours=planner_hours,
        planner_rules=[*data["rules"], decoy_rule],
        label_pages=pages,
        observations={},
    )

    assert metrics["agreement_matrix_model_x_planner"]["PERMITTED"]["BLOCKED"] == 1
    assert metrics["agreement_matrix_model_x_planner"]["BLOCKED"]["PERMITTED"] == 1
    assert metrics["unsafe_go_count"] == 1
    assert metrics["unsafe_go"][0]["planner_rules"][0]["rule_id"] == block["rule"]
    assert metrics["unsafe_go"][0]["planner_rules"][0]["parameter"] == cited_rule["param"]
    assert metrics["lost_window_count"] == 1
    assert metrics["quote_check"] == {"matched": 1, "total": 2, "fraction": 0.5}
    assert details[0]["model"]["quote_match"] is True
    assert details[1]["model"]["quote_match"] is False


def test_response_validation_rejects_extra_root_keys_and_boolean_indices():
    data = fixture()
    period = data["periods"][0]
    hour = {
        "hour_index": 0,
        "start_time": dt.datetime.fromisoformat(period["startTime"]).astimezone(model_alone.LOCAL_ZONE).isoformat(),
        "state": "FIELD_CHECK",
        "reason": "The recorded forecast does not resolve the field condition.",
        "registration": data["rules"][0]["reg"],
        "page": data["rules"][0]["page"],
        "label_sentence": data["rules"][0]["quote"],
    }

    assert model_alone.validate_model_hours({"hours": [hour]}, [period]) == [hour]
    try:
        model_alone.validate_model_hours({"hours": [hour], "extra": True}, [period])
    except ValueError:
        pass
    else:
        raise AssertionError("extra root keys must be rejected")
    try:
        model_alone.validate_model_hours({"hours": [{**hour, "hour_index": False}]}, [period])
    except ValueError:
        pass
    else:
        raise AssertionError("Boolean hour indices must be rejected")
