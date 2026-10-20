"""Compare Nemotron's direct label reading with Labelhand's compiled-rule planner.

The evaluation is fixed to the preregistered Folex 6 EC, Dropp SC, and Prep tank,
three October 2026 mornings, and the first 48 forecast hours. Recorded NWS and
station inputs stay outside git; only the result receipts are committed.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from typing import Any
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "tools"))

import checkback  # noqa: E402
import windows  # noqa: E402
from compile_label import BASE, PRICES, guard, norm  # noqa: E402

DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"
REGISTRATIONS = ("5481-504", "264-700", "264-418")
SAMPLE_DATES = (dt.date(2026, 10, 6), dt.date(2026, 10, 10), dt.date(2026, 10, 14))
LOCAL_ZONE_NAME = "America/New_York"
LOCAL_ZONE = ZoneInfo(LOCAL_ZONE_NAME)
MORNING_START = dt.time(7)
MORNING_END = dt.time(12)
HORIZON_HOURS = 48
MAX_TOKENS = 16_000
BUDGET_USD = 3.0
MAX_ATTEMPTS = 3
STATES = ("PERMITTED", "BLOCKED", "FIELD_CHECK")

HOUR_SCHEMA = {
    "type": "object",
    "properties": {
        "hour_index": {"type": "integer"},
        "start_time": {"type": "string"},
        "state": {"type": "string", "enum": list(STATES)},
        "reason": {"type": "string"},
        "registration": {"type": "string", "enum": list(REGISTRATIONS)},
        "page": {"type": "integer"},
        "label_sentence": {"type": "string"},
    },
    "required": ["hour_index", "start_time", "state", "reason", "registration", "page", "label_sentence"],
    "additionalProperties": False,
}
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        # Revision 2 fixes the length. Revision 1 left it open, and every one of its 10 calls came
        # back with a single hour (receipt: eval/results/model-alone-2026-10-19.schema-v1.json).
        "hours": {
            "type": "array",
            "items": HOUR_SCHEMA,
            "minItems": HORIZON_HOURS,
            "maxItems": HORIZON_HOURS,
        }
    },
    "required": ["hours"],
    "additionalProperties": False,
}
SYSTEM_PROMPT = """You read U.S. EPA pesticide labels and a recorded weather forecast.
Use only the supplied label page text and forecast. Do not assume that a field condition holds when the forecast
cannot establish it. Copy each cited label sentence verbatim from the cited page. Return only the requested JSON."""


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def preregistration(locked_utc: str, model: str = DEFAULT_MODEL, budget_usd: float = BUDGET_USD) -> dict[str, Any]:
    """The design written to the receipt before the first model call."""
    return {
        "locked_before_first_model_call_utc": locked_utc,
        "tank": {
            "products": ["Folex 6 EC", "Dropp SC", "Prep"],
            "registrations": list(REGISTRATIONS),
        },
        "sample": {
            "points": "all 10 points present in the recorded forecast set",
            "dates_local": [day.isoformat() for day in SAMPLE_DATES],
            "selection": (
                "for each point and date, the first recorded issuance at or after 07:00 and before 12:00 America/New_York; record missing without substituting another day"
            ),
            "planned_cases": 30,
        },
        "horizon_hours": HORIZON_HOURS,
        "model_alone": {
            "model": model,
            "temperature": 0,
            "response": "strict JSON schema",
            "response_schema_revision": 2,
            "response_schema_revision_note": (
                "revision 1 did not fix the hours array length and all 10 of its calls returned one hour; "
                "revision 2 requires exactly 48 hours. Sample, prompt, metrics and budget are unchanged."
            ),
            "thinking": False,
            "label_input": (
                "full saved text-layer pages for all three labels; the saved 264-700 OCR second reading is also "
                "shown page by page, matching the compiler pipeline's available readings"
            ),
            "forecast_columns": [
                "start time in local time",
                "temperature F",
                "wind speed mph",
                "wind direction",
                "probability of precipitation",
                "short forecast",
            ],
            "task": (
                "For each hour, say whether this tank may be sprayed according to every label: PERMITTED, "
                "BLOCKED or FIELD_CHECK (the forecast cannot decide), with the label sentence and page you relied on."
            ),
            "compiled_rules_in_prompt": False,
        },
        "planner": {
            "function": "engine/windows.py windows.evaluate",
            "rules": "data/compiled/*.ship.json loaded by windows.load_rules",
        },
        "metrics": [
            "agreement matrix model state x planner state, per case and pooled",
            "unsafe go: model PERMITTED and planner BLOCKED, with blocking rule id, parameter, and quote",
            "lost window: model BLOCKED and planner PERMITTED",
            "quote check using compiler.compile_label.guard's whitespace-insensitive page match",
            "station check for each system's PERMITTED hours using tools.checkback.check_permitted_rules",
            "response tokens, latency, and list-price cost per call",
        ],
        "budget": {
            "maximum_usd": budget_usd,
            "policy": "stop with a partial receipt before the next call whose conservative maximum would exceed the budget",
            "retries": "at most two retries after the first failed attempt, with backoff; every attempt is recorded",
        },
        "invalid_output_policy": "invalid JSON or an omitted, duplicate, reordered, or wrong-time hour is a failed attempt; never repair by guessing",
        "data_policy": "recorded label text, NWS forecasts, and station observations only; no synthetic evaluation inputs",
    }


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def input_receipt(path_value: str | pathlib.Path, root: pathlib.Path) -> dict[str, str]:
    path = pathlib.Path(path_value).resolve()
    return {
        "source_file": path.relative_to(root.resolve()).as_posix(),
        "source_sha256": file_sha256(path),
    }


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    temporary.replace(path)


def load_label_pages(text_dir: pathlib.Path) -> dict[str, dict[int, list[dict[str, str]]]]:
    pages: dict[str, dict[int, list[dict[str, str]]]] = {}
    for registration in REGISTRATIONS:
        path = text_dir / f"{registration}.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list) or not value or not all(isinstance(page, str) for page in value):
            raise ValueError(f"{path} must be a non-empty JSON array of page strings")
        pages[registration] = {index: [{"reading": "text-layer", "text": text}] for index, text in enumerate(value, 1)}

    ocr_path = text_dir / "264-700.ocr.json"
    ocr = json.loads(ocr_path.read_text(encoding="utf-8"))
    label_index_path = text_dir.parent / "labels" / "index.json"
    label_index = json.loads(label_index_path.read_text(encoding="utf-8"))
    expected_label_sha = label_index["264-700"]["sha256"]
    if ocr.get("label_sha256") != expected_label_sha:
        raise ValueError(f"{ocr_path} was made from a different label file ({ocr.get('label_sha256')} != {expected_label_sha})")
    ocr_pages = ocr.get("pages")
    if not isinstance(ocr_pages, dict):
        raise ValueError(f"{ocr_path} must contain a pages object")
    for page_text, text in ocr_pages.items():
        if not str(page_text).isdigit() or not isinstance(text, str):
            raise ValueError(f"{ocr_path} has an invalid page entry")
        page = int(page_text)
        if page not in pages["264-700"]:
            raise ValueError(f"{ocr_path} contains unknown page {page}")
        pages["264-700"][page].append({"reading": "ocr-second-reading", "text": text})
    return pages


def render_label_pages(label_pages: dict[str, dict[int, list[dict[str, str]]]]) -> str:
    chunks = []
    for registration in REGISTRATIONS:
        for page in sorted(label_pages[registration]):
            for reading in label_pages[registration][page]:
                chunks.append(
                    f"[LABEL registration={registration} page={page} reading={reading['reading']}]\n"
                    f"{reading['text']}\n"
                    f"[/LABEL registration={registration} page={page} reading={reading['reading']}]"
                )
    return "\n\n".join(chunks)


def table_cell(value: Any) -> str:
    if value is None or value == "":
        return "NOT RECORDED"
    return str(value).replace("|", "/").replace("\r", " ").replace("\n", " ")


def forecast_table(periods: list[dict[str, Any]]) -> str:
    rows = ["| hour | start local | temperature F | wind speed mph | wind direction | precipitation % | short forecast |", "|---:|---|---:|---|---|---:|---|"]
    for index, period in enumerate(periods):
        start = dt.datetime.fromisoformat(period["startTime"]).astimezone(LOCAL_ZONE).isoformat()
        pop = (period.get("probabilityOfPrecipitation") or {}).get("value")
        rows.append(
            "| "
            + " | ".join(
                (
                    str(index),
                    table_cell(start),
                    table_cell(period.get("temperature")),
                    table_cell(period.get("windSpeed")),
                    table_cell(period.get("windDirection")),
                    table_cell(pop),
                    table_cell(period.get("shortForecast")),
                )
            )
            + " |"
        )
    return "\n".join(rows)


def build_prompt(label_pages: dict[str, dict[int, list[dict[str, str]]]], periods: list[dict[str, Any]]) -> str:
    definitions = """Use these three states exactly:
- PERMITTED: Every rule of every product in the tank is satisfied by the forecast for that hour.
- BLOCKED: At least one rule is violated.
- FIELD_CHECK: The forecast cannot decide, so the applicator must check on site.

Advisory language does not block an hour. Never say the spray is legal. If the forecast lacks information needed
to decide a mandatory label condition, return FIELD_CHECK rather than PERMITTED."""
    task = (
        "For each hour, say whether this tank may be sprayed according to every label: PERMITTED, BLOCKED or "
        "FIELD_CHECK (the forecast cannot decide), with the label sentence and page you relied on."
    )
    return f"""TANK
Folex 6 EC (EPA registration 5481-504) + Dropp SC (264-700) + Prep (264-418).

{definitions}

TASK
{task}
Return one object for each forecast row, in the same order. Use the zero-based hour value as hour_index and copy
start local exactly as start_time. Copy one complete, decision-relevant label sentence verbatim as label_sentence,
with its registration and one-based page. Keep reason concise. Do not use or infer any compiled rules.

LABEL PAGES
{render_label_pages(label_pages)}

RECORDED NWS FORECAST, FIRST {len(periods)} HOURS
{forecast_table(periods)}
"""


def request_body(prompt: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    return {
        "model": model,
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "model_alone_hours", "schema": RESPONSE_SCHEMA, "strict": True},
        },
        "chat_template_kwargs": {"enable_thinking": False},
    }


def request_estimate(body: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    heuristic_input = (len(encoded) + 3) // 4
    input_upper_bound = len(encoded)
    input_price, output_price = PRICES[body["model"]]
    maximum_cost = input_upper_bound / 1_000_000 * input_price + MAX_TOKENS / 1_000_000 * output_price
    return {
        "request_bytes": len(encoded),
        "estimated_input_tokens": heuristic_input,
        "input_token_upper_bound": input_upper_bound,
        "maximum_completion_tokens": MAX_TOKENS,
        "conservative_maximum_cost_usd": round(maximum_cost, 6),
    }


def select_morning_issuance(issuances: list[dict[str, Any]], day: dt.date) -> dict[str, Any] | None:
    start = dt.datetime.combine(day, MORNING_START, LOCAL_ZONE)
    end = dt.datetime.combine(day, MORNING_END, LOCAL_ZONE)
    candidates = [item for item in issuances if start <= item["fetched"].astimezone(LOCAL_ZONE) < end]
    return min(candidates, key=lambda item: (item["fetched"], item["path"])) if candidates else None


def select_cases(hourly_by_point: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    cases = []
    for point in sorted(hourly_by_point):
        for day in SAMPLE_DATES:
            issuance = select_morning_issuance(hourly_by_point[point], day)
            cases.append({"id": f"{point}-{day.isoformat()}", "point": point, "date_local": day.isoformat(), "issuance": issuance})
    return cases


def validate_model_hours(value: Any, periods: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != {"hours"} or not isinstance(value["hours"], list):
        raise ValueError("response is not an object with an hours array")
    hours = value["hours"]
    if len(hours) != len(periods):
        raise ValueError(f"response has {len(hours)} hours, expected {len(periods)}")
    required = {"hour_index", "start_time", "state", "reason", "registration", "page", "label_sentence"}
    for index, (hour, period) in enumerate(zip(hours, periods, strict=True)):
        if not isinstance(hour, dict) or set(hour) != required:
            raise ValueError(f"hour {index} has the wrong fields")
        expected_start = dt.datetime.fromisoformat(period["startTime"]).astimezone(LOCAL_ZONE).isoformat()
        if isinstance(hour["hour_index"], bool) or not isinstance(hour["hour_index"], int):
            raise ValueError(f"hour {index} has non-integer hour_index {hour['hour_index']!r}")
        if hour["hour_index"] != index:
            raise ValueError(f"hour {index} has hour_index {hour['hour_index']!r}")
        if hour["start_time"] != expected_start:
            raise ValueError(f"hour {index} start_time does not match the forecast")
        if hour["state"] not in STATES:
            raise ValueError(f"hour {index} has invalid state {hour['state']!r}")
        if hour["registration"] not in REGISTRATIONS:
            raise ValueError(f"hour {index} has invalid registration {hour['registration']!r}")
        if isinstance(hour["page"], bool) or not isinstance(hour["page"], int) or hour["page"] < 1:
            raise ValueError(f"hour {index} has invalid page {hour['page']!r}")
        for field in ("reason", "label_sentence"):
            if not isinstance(hour[field], str) or not hour[field].strip():
                raise ValueError(f"hour {index} has empty {field}")
    return hours


def quote_match(
    sentence: str,
    registration: str,
    page: int,
    label_pages: dict[str, dict[int, list[dict[str, str]]]],
) -> tuple[bool, list[str]]:
    matches = []
    for reading in label_pages.get(registration, {}).get(page, []):
        candidate = {"quote": sentence, "value": None, "value2": None}
        if guard(candidate, norm(reading["text"])) is None:
            matches.append(reading["reading"])
    return bool(matches), matches


def empty_matrix() -> dict[str, dict[str, int]]:
    return {model: {planner: 0 for planner in STATES} for model in STATES}


def empty_observation_counts() -> dict[str, int]:
    return {
        "permitted_hours": 0,
        "with_observation": 0,
        "no_observation": 0,
        "held": 0,
        "broke": 0,
        "skipped_missing_measurement": 0,
        "not_checkable": 0,
    }


def blocking_rules(
    planner_hour: dict[str, Any],
    rule_by_citation: dict[tuple[str, str, str], dict[str, Any]],
) -> list[dict[str, Any]]:
    rules = []
    for citation in planner_hour["blocked"]:
        key = (citation["product"], citation["rule"], citation["quote"])
        rule = rule_by_citation.get(key, {})
        rules.append(
            {
                "rule_id": citation["rule"],
                "parameter": rule.get("param"),
                "product": citation["product"],
                "page": citation["page"],
                "quote": citation["quote"],
                "why": citation["why"],
            }
        )
    return rules


def compute_case_metrics(
    *,
    point: str,
    date_local: str,
    periods: list[dict[str, Any]],
    model_hours: list[dict[str, Any]],
    planner_hours: list[dict[str, Any]],
    planner_rules: list[dict[str, Any]],
    label_pages: dict[str, dict[int, list[dict[str, str]]]],
    observations: dict[dt.datetime, dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not (len(periods) == len(model_hours) == len(planner_hours)):
        raise ValueError("forecast, model, and planner hour counts differ")
    matrix = empty_matrix()
    unsafe_go = []
    lost_window = []
    quote_matched = 0
    observation_counts = {"model_permitted": empty_observation_counts(), "planner_permitted": empty_observation_counts()}
    rule_by_citation = {(rule["product"], rule["id"], rule["quote"]): rule for rule in planner_rules}
    details = []

    for index, (period, model_hour, planner_hour) in enumerate(zip(periods, model_hours, planner_hours, strict=True)):
        model_state = model_hour["state"]
        planner_state = planner_hour["state"]
        matrix[model_state][planner_state] += 1
        matched, readings = quote_match(
            model_hour["label_sentence"],
            model_hour["registration"],
            model_hour["page"],
            label_pages,
        )
        quote_matched += int(matched)
        model_detail = {**model_hour, "quote_match": matched, "quote_match_readings": readings}
        planner_blocks = blocking_rules(planner_hour, rule_by_citation)

        if model_state == "PERMITTED" and planner_state == "BLOCKED":
            unsafe_go.append(
                {
                    "point": point,
                    "date_local": date_local,
                    "hour_index": index,
                    "time": model_hour["start_time"],
                    "model_reason": model_hour["reason"],
                    "model_citation": {
                        "registration": model_hour["registration"],
                        "page": model_hour["page"],
                        "sentence": model_hour["label_sentence"],
                        "quote_match": matched,
                    },
                    "planner_rules": planner_blocks,
                }
            )
        if model_state == "BLOCKED" and planner_state == "PERMITTED":
            lost_window.append(
                {
                    "point": point,
                    "date_local": date_local,
                    "hour_index": index,
                    "time": model_hour["start_time"],
                    "model_reason": model_hour["reason"],
                    "model_citation": {
                        "registration": model_hour["registration"],
                        "page": model_hour["page"],
                        "sentence": model_hour["label_sentence"],
                        "quote_match": matched,
                    },
                }
            )

        hour_utc = checkback.parse_datetime(period["startTime"], f"period {index} startTime")
        observation = observations.get(hour_utc)
        observation_detail = None
        if observation is not None:
            weather = checkback.observed_weather(observation["data"])
            observation_detail = {
                "timestamp": observation["timestamp"],
                "station_id": observation["station_id"],
                "station_name": observation["station_name"],
                "input_source": observation["input_source"],
                "weather": weather,
            }
            for system, state in (("model_permitted", model_state), ("planner_permitted", planner_state)):
                if state != "PERMITTED":
                    continue
                result = checkback.check_permitted_rules(planner_rules, weather)
                observation_counts[system]["permitted_hours"] += 1
                observation_counts[system]["with_observation"] += 1
                observation_counts[system][result["outcome"]] += 1
                observation_detail[system] = result
        else:
            if model_state == "PERMITTED":
                observation_counts["model_permitted"]["permitted_hours"] += 1
                observation_counts["model_permitted"]["no_observation"] += 1
            if planner_state == "PERMITTED":
                observation_counts["planner_permitted"]["permitted_hours"] += 1
                observation_counts["planner_permitted"]["no_observation"] += 1

        details.append(
            {
                "hour_index": index,
                "forecast": {
                    "start_time": model_hour["start_time"],
                    "temperature_f": period.get("temperature"),
                    "wind_speed_mph": period.get("windSpeed"),
                    "wind_direction": period.get("windDirection"),
                    "probability_of_precipitation": (period.get("probabilityOfPrecipitation") or {}).get("value"),
                    "short_forecast": period.get("shortForecast"),
                },
                "model": model_detail,
                "planner": planner_hour,
                "station_observation": observation_detail,
            }
        )

    metrics = {
        "hours_compared": len(periods),
        "agreement_matrix_model_x_planner": matrix,
        "unsafe_go_count": len(unsafe_go),
        "unsafe_go": unsafe_go,
        "lost_window_count": len(lost_window),
        "lost_window": lost_window,
        "quote_check": {
            "matched": quote_matched,
            "total": len(model_hours),
            "fraction": round(quote_matched / len(model_hours), 6) if model_hours else None,
        },
        "against_observations": observation_counts,
    }
    return metrics, details


def validate_usage(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("response usage is not an object")
    for field in ("prompt_tokens", "completion_tokens"):
        amount = value.get(field)
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
            raise ValueError(f"response usage has invalid {field}")
    return value


def cost_from_usage(usage: dict[str, Any], model: str) -> float:
    prompt_tokens = usage["prompt_tokens"]
    completion_tokens = usage["completion_tokens"]
    input_price, output_price = PRICES[model]
    return prompt_tokens / 1_000_000 * input_price + completion_tokens / 1_000_000 * output_price


def model_attempt(body: dict[str, Any], key: str, attempt_number: int) -> tuple[dict[str, Any], Any | None]:
    started = time.perf_counter()
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        BASE + "/chat/completions",
        data=encoded,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.load(response)
            request_id = response.headers.get("x-request-id", "")
            http_status = response.status
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", "replace")[:300]
        return (
            {
                "attempt": attempt_number,
                "status": "http_error",
                "http_status": exc.code,
                "latency_ms": round((time.perf_counter() - started) * 1000),
                "request_id": exc.headers.get("x-request-id", "") if exc.headers else "",
                "usage": {},
                "cost_usd": None,
                "error": f"HTTP {exc.code}: {body_text}",
            },
            None,
        )
    except Exception as exc:
        return (
            {
                "attempt": attempt_number,
                "status": "transport_error",
                "latency_ms": round((time.perf_counter() - started) * 1000),
                "request_id": "",
                "usage": {},
                "cost_usd": None,
                "error": f"{type(exc).__name__}: {exc}",
            },
            None,
        )

    raw_usage = payload.get("usage") if isinstance(payload, dict) else None
    record = {
        "attempt": attempt_number,
        "status": "response_received",
        "http_status": http_status,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "request_id": request_id,
        "usage": raw_usage if isinstance(raw_usage, dict) else {},
        "cost_usd": None,
        "finish_reason": None,
    }
    try:
        usage = validate_usage(raw_usage)
        record["usage"] = usage
        record["cost_usd"] = round(cost_from_usage(usage, body["model"]), 8)
        choices = payload["choices"]
        if not isinstance(choices, list) or len(choices) != 1:
            raise ValueError("response must contain exactly one choice")
        choice = choices[0]
        if not isinstance(choice, dict):
            raise ValueError("response choice is not an object")
        record["finish_reason"] = choice.get("finish_reason")
        if choice.get("finish_reason") != "stop":
            raise ValueError(f"finish_reason={choice.get('finish_reason')!r}, expected 'stop'")
        content = choice["message"]["content"]
        if not isinstance(content, str):
            raise ValueError("assistant content is not a string")
        parsed = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValueError) as exc:
        record["status"] = "invalid_response"
        record["error"] = f"{type(exc).__name__}: {exc}"
        return record, None
    return record, parsed


def add_counts(target: dict[str, int], source: dict[str, int]) -> None:
    for key in target:
        target[key] += source[key]


def summarize(result: dict[str, Any]) -> dict[str, Any]:
    matrix = empty_matrix()
    unsafe_go = []
    lost_window = []
    quote_matched = quote_total = 0
    observation_counts = {"model_permitted": empty_observation_counts(), "planner_permitted": empty_observation_counts()}
    successful = failed = missing = not_attempted = 0
    hours_compared = 0
    attempts = []

    for case in result["cases"]:
        attempts.extend(case.get("model_calls", []))
        if case["status"] == "missing_issuance":
            missing += 1
            continue
        if case["status"] == "not_attempted":
            not_attempted += 1
            continue
        if case["status"] != "complete":
            failed += 1
            continue
        successful += 1
        metrics = case["metrics"]
        hours_compared += metrics["hours_compared"]
        for model_state in STATES:
            for planner_state in STATES:
                matrix[model_state][planner_state] += metrics["agreement_matrix_model_x_planner"][model_state][planner_state]
        unsafe_go.extend(metrics["unsafe_go"])
        lost_window.extend(metrics["lost_window"])
        quote_matched += metrics["quote_check"]["matched"]
        quote_total += metrics["quote_check"]["total"]
        for system in observation_counts:
            add_counts(observation_counts[system], metrics["against_observations"][system])

    known_costs = [call["cost_usd"] for call in attempts if call.get("cost_usd") is not None]
    unknown_cost_attempts = sum(call.get("cost_usd") is None for call in attempts)
    prompt_tokens = sum(call.get("usage", {}).get("prompt_tokens", 0) for call in attempts)
    completion_tokens = sum(call.get("usage", {}).get("completion_tokens", 0) for call in attempts)
    reported_cost = round(sum(known_costs), 8)
    budget_accounted_cost = round(
        sum(call.get("budget_accounted_cost_usd", call.get("cost_usd") or 0.0) for call in attempts),
        8,
    )
    return {
        "planned_cases": result["preregistration"]["sample"]["planned_cases"],
        "selected_cases": result["run"]["selected_cases"],
        "successful_cases": successful,
        "failed_cases": failed,
        "missing_issuance_cases": missing,
        "not_attempted_cases": not_attempted,
        "hours_compared": hours_compared,
        "agreement_matrix_model_x_planner": matrix,
        "unsafe_go_count": len(unsafe_go),
        "unsafe_go": unsafe_go,
        "lost_window_count": len(lost_window),
        "lost_window": lost_window,
        "quote_check": {
            "matched": quote_matched,
            "total": quote_total,
            "fraction": round(quote_matched / quote_total, 6) if quote_total else None,
        },
        "against_observations": observation_counts,
        "model_calls": {
            "attempts": len(attempts),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "latency_ms": sum(call.get("latency_ms", 0) for call in attempts),
            "cost_usd": reported_cost if unknown_cost_attempts == 0 else None,
            "reported_cost_usd": reported_cost,
            "unknown_cost_attempts": unknown_cost_attempts,
            "budget_accounted_cost_usd": budget_accounted_cost,
        },
    }


def public_summary(result: dict[str, Any], source: str) -> dict[str, Any]:
    summary = copy.deepcopy(result["summary"])
    unsafe_go = summary.pop("unsafe_go")
    summary.pop("lost_window")
    return {
        "schema_version": result["schema_version"],
        "generated_utc": result["run"].get("finished_utc"),
        "model": result["preregistration"]["model_alone"]["model"],
        "tank_registrations": list(REGISTRATIONS),
        "sample_dates_local": [day.isoformat() for day in SAMPLE_DATES],
        "status": result["run"]["status"],
        "pooled": summary,
        "unsafe_go_hours": unsafe_go,
        "source": source,
    }


def persist(result: dict[str, Any], out: pathlib.Path, summary_out: pathlib.Path | None, prereg_hash: str) -> None:
    if canonical_hash(result["preregistration"]) != prereg_hash:
        raise RuntimeError("preregistration changed after it was locked")
    result["summary"] = summarize(result)
    write_json(out, result)
    if summary_out is not None:
        resolved_out = out.resolve()
        try:
            source = resolved_out.relative_to(ROOT.resolve()).as_posix()
        except ValueError:
            source = resolved_out.as_posix()
        write_json(summary_out, public_summary(result, source))


def dry_run(cases: list[dict[str, Any]], label_pages: dict[str, dict[int, list[dict[str, str]]]], model: str) -> int:
    totals = {"cases": len(cases), "missing": 0, "estimated_input_tokens": 0, "input_token_upper_bound": 0, "conservative_maximum_cost_usd": 0.0}
    for case in cases:
        issuance = case["issuance"]
        if issuance is None:
            totals["missing"] += 1
            print(json.dumps({"case": case["id"], "status": "missing_issuance"}, separators=(",", ":")))
            continue
        periods = issuance["periods"][:HORIZON_HOURS]
        prompt = build_prompt(label_pages, periods)
        estimate = request_estimate(request_body(prompt, model))
        totals["estimated_input_tokens"] += estimate["estimated_input_tokens"]
        totals["input_token_upper_bound"] += estimate["input_token_upper_bound"]
        totals["conservative_maximum_cost_usd"] += estimate["conservative_maximum_cost_usd"]
        print(json.dumps({"case": case["id"], "status": "ready", "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(), **estimate}, separators=(",", ":")))
    totals["conservative_maximum_cost_usd"] = round(totals["conservative_maximum_cost_usd"], 6)
    print(json.dumps({"total": totals}, separators=(",", ":")))
    return 0


def run_evaluation(
    *,
    cases: list[dict[str, Any]],
    label_pages: dict[str, dict[int, list[dict[str, str]]]],
    observations_by_point: dict[str, list[dict[str, Any]]],
    point_cache: dict[str, Any],
    out: pathlib.Path,
    summary_out: pathlib.Path | None,
    command: str,
    recorded_stats: dict[str, Any],
    observation_stats: dict[str, Any],
    recorded_root: pathlib.Path,
    model: str,
    budget_usd: float,
) -> int:
    locked_utc = utc_now()
    prereg = preregistration(locked_utc, model, budget_usd)
    prereg_hash = canonical_hash(prereg)
    result = {
        "schema_version": 1,
        "preregistration": prereg,
        "preregistration_sha256": prereg_hash,
        "run": {
            "status": "preregistered",
            "started_utc": locked_utc,
            "finished_utc": None,
            "command": command,
            "selected_cases": len(cases),
            "input_counts": recorded_stats | observation_stats,
            "stop_reason": None,
        },
        "cases": [],
        "summary": {},
    }
    persist(result, out, summary_out, prereg_hash)

    key = os.environ.get("NEBIUS_API_KEY", "").strip()
    if not key:
        result["run"].update({"status": "failed", "finished_utc": utc_now(), "stop_reason": "NEBIUS_API_KEY missing"})
        persist(result, out, summary_out, prereg_hash)
        return 2

    planner_rules = []
    topic_skipped = []
    compiled_rule_sources = []
    for registration in REGISTRATIONS:
        _, used, skipped = windows.load_rules(registration)
        planner_rules.extend(used)
        topic_skipped.extend({"registration": registration, **item} for item in skipped)
        rules_path = windows.COMPILED / f"{registration}{windows.DEFAULT_RULES}.json"
        compiled_rule_sources.append({"registration": registration, **input_receipt(rules_path, ROOT)})
    result["run"]["compiled_rule_sources"] = compiled_rule_sources
    assigned_observations = {}
    for point, values in observations_by_point.items():
        assigned, _ = checkback.assign_observations(values)
        assigned_observations[point] = {
            hour: {
                **observation,
                "input_source": input_receipt(observation["path"], recorded_root),
            }
            for hour, observation in assigned.items()
        }
    persist(result, out, summary_out, prereg_hash)
    budget_liability = 0.0
    budget_stopped = False
    fatal_api = False

    for selected in cases:
        issuance = selected["issuance"]
        case = {"id": selected["id"], "point": selected["point"], "date_local": selected["date_local"], "status": "pending", "model_calls": []}
        result["cases"].append(case)
        if issuance is None:
            case.update({"status": "missing_issuance", "error": "no recorded issuance from 07:00 through 11:59 America/New_York"})
            persist(result, out, summary_out, prereg_hash)
            continue
        if len(issuance["periods"]) < HORIZON_HOURS:
            case.update({"status": "failed", "error": f"issuance contains only {len(issuance['periods'])} forecast hours"})
            persist(result, out, summary_out, prereg_hash)
            continue

        periods = issuance["periods"][:HORIZON_HOURS]
        prompt = build_prompt(label_pages, periods)
        body = request_body(prompt, model)
        estimate = request_estimate(body)
        case.update(
            {
                "status": "calling_model",
                "issuance_fetched_utc": issuance["fetched_utc"],
                "issuance_fetched_local": issuance["fetched"].astimezone(LOCAL_ZONE).isoformat(),
                **input_receipt(issuance["path"], recorded_root),
                "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "prompt_estimate": estimate,
                "planner_topic_skipped_rules": topic_skipped,
            }
        )
        persist(result, out, summary_out, prereg_hash)

        parsed = None
        for attempt_number in range(1, MAX_ATTEMPTS + 1):
            projected = estimate["conservative_maximum_cost_usd"]
            if budget_liability + projected > budget_usd:
                case.update({"status": "stopped_budget", "error": f"next call maximum would exceed USD {budget_usd:.2f}"})
                result["run"]["stop_reason"] = case["error"]
                budget_stopped = True
                persist(result, out, summary_out, prereg_hash)
                break
            call_record, response = model_attempt(body, key, attempt_number)
            accounted_cost = call_record["cost_usd"] if call_record["cost_usd"] is not None else projected
            call_record["budget_accounted_cost_usd"] = round(accounted_cost, 8)
            budget_liability += accounted_cost
            try:
                model_hours = validate_model_hours(response, periods) if response is not None else None
            except ValueError as exc:
                call_record["status"] = "invalid_response"
                call_record["error"] = f"{type(exc).__name__}: {exc}"
                model_hours = None
            if model_hours is not None:
                parsed = model_hours
                call_record["status"] = "success"
            case["model_calls"].append(call_record)
            persist(result, out, summary_out, prereg_hash)
            if model_hours is not None:
                break
            if call_record.get("http_status") in {400, 401, 402, 403}:
                fatal_api = True
                case.update(
                    {
                        "status": "failed",
                        "error": f"nonretryable API response HTTP {call_record['http_status']}",
                    }
                )
                result["run"]["stop_reason"] = case["error"]
                persist(result, out, summary_out, prereg_hash)
                break
            if attempt_number < MAX_ATTEMPTS:
                time.sleep(2 + 4 * (attempt_number - 1))
        if budget_stopped or fatal_api:
            break
        if parsed is None:
            case.update({"status": "failed", "error": "model failed all recorded attempts"})
            persist(result, out, summary_out, prereg_hash)
            continue

        meta = point_cache[selected["point"]]
        planner_hours = windows.evaluate(planner_rules, periods, float(meta["lat"]), float(meta["lon"]), HORIZON_HOURS)
        metrics, hour_details = compute_case_metrics(
            point=selected["point"],
            date_local=selected["date_local"],
            periods=periods,
            model_hours=parsed,
            planner_hours=planner_hours,
            planner_rules=planner_rules,
            label_pages=label_pages,
            observations=assigned_observations.get(selected["point"], {}),
        )
        case.update({"status": "complete", "metrics": metrics, "hours": hour_details})
        persist(result, out, summary_out, prereg_hash)

    recorded_case_ids = {case["id"] for case in result["cases"]}
    for selected in cases:
        if selected["id"] not in recorded_case_ids:
            result["cases"].append(
                {
                    "id": selected["id"],
                    "point": selected["point"],
                    "date_local": selected["date_local"],
                    "status": "not_attempted",
                    "model_calls": [],
                    "error": result["run"]["stop_reason"],
                }
            )

    result["run"]["finished_utc"] = utc_now()
    if budget_stopped:
        result["run"]["status"] = "partial_budget"
    elif fatal_api:
        result["run"]["status"] = "partial_api_failure"
    elif any(case["status"] == "failed" for case in result["cases"]):
        result["run"]["status"] = "complete_with_failures"
    else:
        result["run"]["status"] = "complete"
    persist(result, out, summary_out, prereg_hash)
    return 0 if result["run"]["status"] == "complete" else 1


def exact_command(argv: list[str]) -> str:
    return "python tools/model_alone.py " + " ".join(argv)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recorded", required=True, type=pathlib.Path)
    parser.add_argument("--text-dir", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--summary-out", type=pathlib.Path)
    parser.add_argument("--model", choices=tuple(PRICES), default=DEFAULT_MODEL)
    parser.add_argument("--budget-usd", type=float, default=BUDGET_USD)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--cases", type=int)
    args = parser.parse_args(argv)

    hourly_by_point, recorded_stats = checkback.load_hourly(args.recorded)
    if not hourly_by_point:
        raise SystemExit("no valid recorded hourly forecasts")
    all_cases = select_cases(hourly_by_point)
    if len(all_cases) != 30:
        raise SystemExit(f"expected 30 point-date cases, found {len(all_cases)}")
    if args.cases is not None and not 1 <= args.cases <= len(all_cases):
        parser.error(f"--cases must be from 1 through {len(all_cases)}")
    if not math.isfinite(args.budget_usd) or args.budget_usd <= 0:
        parser.error("--budget-usd must be a finite number greater than zero")
    cases = all_cases[: args.cases] if args.cases is not None else all_cases
    label_pages = load_label_pages(args.text_dir)
    if args.dry_run:
        return dry_run(cases, label_pages, args.model)

    observations_by_point, observation_stats = checkback.load_observations(args.recorded)
    point_cache = json.loads(windows.CACHE.read_text(encoding="utf-8"))
    return run_evaluation(
        cases=cases,
        label_pages=label_pages,
        observations_by_point=observations_by_point,
        point_cache=point_cache,
        out=args.out,
        summary_out=args.summary_out,
        command=exact_command(argv or sys.argv[1:]),
        recorded_stats=recorded_stats,
        observation_stats=observation_stats,
        recorded_root=args.recorded,
        model=args.model,
        budget_usd=args.budget_usd,
    )


if __name__ == "__main__":
    sys.exit(main())
