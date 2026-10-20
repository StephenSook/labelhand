"""Compare day-ahead Labelhand permits with recorded ASOS observations."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import pathlib
import shlex
import sys
from collections import defaultdict
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

import windows  # noqa: E402

REGISTRATIONS = ("5481-504", "228-653", "228-659")
OBS_TOLERANCE = dt.timedelta(minutes=40)
ISSUANCE_TOLERANCE = dt.timedelta(minutes=90)
KM_PER_INTERNATIONAL_MILE = 1.609344


class BadRecordedFile(ValueError):
    """A recorder payload cannot be used safely."""


def parse_datetime(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise BadRecordedFile(f"{field} is not a non-empty string")
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as exc:
        raise BadRecordedFile(f"{field} is not RFC3339") from exc
    if parsed.tzinfo is None:
        raise BadRecordedFile(f"{field} has no UTC offset")
    return parsed.astimezone(dt.UTC)


def read_gzip_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BadRecordedFile(f"cannot read gzip JSON: {type(exc).__name__}: {exc}") from exc
    if not isinstance(value, dict):
        raise BadRecordedFile("record envelope is not an object")
    return value


def load_hourly(recorded: pathlib.Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    paths = sorted(recorded.rglob("*_hourly.json.gz"))
    by_point: dict[str, list[dict[str, Any]]] = defaultdict(list)
    bad: list[dict[str, str]] = []
    for path in paths:
        try:
            record = read_gzip_json(path)
            if record.get("kind") != "hourly":
                raise BadRecordedFile("kind is not hourly")
            point = record.get("point")
            if not isinstance(point, str) or not point:
                raise BadRecordedFile("point is not a non-empty string")
            fetched = parse_datetime(record.get("fetched_utc"), "fetched_utc")
            data = record.get("data")
            if not isinstance(data, dict) or not isinstance(data.get("periods"), list) or not data["periods"]:
                raise BadRecordedFile("data.periods is not a non-empty array")
            periods = data["periods"]
            period_hours = set()
            for index, period in enumerate(periods):
                if not isinstance(period, dict) or not isinstance(period.get("startTime"), str):
                    raise BadRecordedFile(f"period {index} has no startTime")
                period_hours.add(parse_datetime(period["startTime"], f"period {index} startTime"))
            by_point[point].append(
                {
                    "fetched": fetched,
                    "fetched_utc": record["fetched_utc"],
                    "periods": periods,
                    "period_hours": period_hours,
                    "path": str(path),
                }
            )
        except BadRecordedFile as exc:
            bad.append({"file": str(path), "error": str(exc)})
    for issuances in by_point.values():
        issuances.sort(key=lambda item: (item["fetched"], item["path"]))
    return by_point, {
        "hourly_files": len(paths),
        "valid_hourly_files": sum(len(values) for values in by_point.values()),
        "bad_hourly_files": len(bad),
        "bad_hourly_examples": bad[:5],
    }


def load_observations(recorded: pathlib.Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    paths = sorted(recorded.rglob("*_obs.json.gz"))
    unique: dict[tuple[str, str, dt.datetime], dict[str, Any]] = {}
    bad: list[dict[str, str]] = []
    valid = 0
    for path in paths:
        try:
            record = read_gzip_json(path)
            if record.get("kind") != "obs":
                raise BadRecordedFile("kind is not obs")
            point = record.get("point")
            if not isinstance(point, str) or not point:
                raise BadRecordedFile("point is not a non-empty string")
            data = record.get("data")
            if not isinstance(data, dict):
                raise BadRecordedFile("data is not an object")
            observed = parse_datetime(data.get("timestamp"), "data.timestamp")
            fetched = parse_datetime(record.get("fetched_utc"), "fetched_utc")
            station_id = data.get("stationId")
            station_name = data.get("stationName")
            if not isinstance(station_id, str) or not station_id:
                raise BadRecordedFile("data.stationId is not a non-empty string")
            if not isinstance(station_name, str) or not station_name:
                raise BadRecordedFile("data.stationName is not a non-empty string")
            valid += 1
            key = (point, station_id, observed)
            candidate = {
                "point": point,
                "observed": observed,
                "timestamp": data["timestamp"],
                "fetched": fetched,
                "station_id": station_id,
                "station_name": station_name,
                "data": data,
                "path": str(path),
            }
            current = unique.get(key)
            if current is None or (fetched, str(path)) < (current["fetched"], current["path"]):
                unique[key] = candidate
        except BadRecordedFile as exc:
            bad.append({"file": str(path), "error": str(exc)})
    by_point: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for observation in unique.values():
        by_point[observation["point"]].append(observation)
    for observations in by_point.values():
        observations.sort(key=lambda item: (item["observed"], item["station_id"], item["path"]))
    return by_point, {
        "observation_files": len(paths),
        "valid_observation_files": valid,
        "bad_observation_files": len(bad),
        "bad_observation_examples": bad[:5],
        "unique_observations": len(unique),
        "duplicate_observations": valid - len(unique),
    }


def floor_hour(value: dt.datetime) -> dt.datetime:
    return value.astimezone(dt.UTC).replace(minute=0, second=0, microsecond=0)


def nearest_hour(value: dt.datetime) -> dt.datetime:
    lower = floor_hour(value)
    upper = lower + dt.timedelta(hours=1)
    return lower if value - lower <= upper - value else upper


def assign_observations(observations: list[dict[str, Any]]) -> tuple[dict[dt.datetime, dict[str, Any]], int]:
    assigned: dict[dt.datetime, dict[str, Any]] = {}
    outside = 0
    for observation in observations:
        hour = nearest_hour(observation["observed"])
        distance = abs(observation["observed"] - hour)
        if distance > OBS_TOLERANCE:
            outside += 1
            continue
        candidate_key = (distance, observation["observed"], observation["station_id"], observation["path"])
        current = assigned.get(hour)
        if current is None:
            assigned[hour] = observation
            continue
        current_key = (
            abs(current["observed"] - hour),
            current["observed"],
            current["station_id"],
            current["path"],
        )
        if candidate_key < current_key:
            assigned[hour] = observation
    return assigned, outside


def closest_issuance(issuances: list[dict[str, Any]], target: dt.datetime) -> dict[str, Any] | None:
    if not issuances:
        return None
    candidate = min(issuances, key=lambda item: (abs(item["fetched"] - target), item["fetched"], item["path"]))
    return candidate if abs(candidate["fetched"] - target) <= ISSUANCE_TOLERANCE else None


def kmh_to_mph(value: float) -> float:
    # Exact because one international mile is 1.609344 kilometers.
    return value / KM_PER_INTERNATIONAL_MILE


def celsius_to_fahrenheit(value: float) -> float:
    # Exact Celsius to Fahrenheit conversion.
    return value * 9.0 / 5.0 + 32.0


def measurement(data: dict[str, Any], field: str, unit: str) -> tuple[float | None, str | None]:
    item = data.get(field)
    if not isinstance(item, dict):
        return None, f"{field} is missing"
    if item.get("unitCode") != unit:
        return None, f"{field} unit is {item.get('unitCode')!r}, expected {unit!r}"
    value = item.get("value")
    if value is None:
        return None, f"{field} value is null"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, f"{field} value is not numeric"
    return float(value), None


def observed_weather(data: dict[str, Any]) -> dict[str, Any]:
    wind_kmh, wind_error = measurement(data, "windSpeed", "wmoUnit:km_h-1")
    temperature_c, temperature_error = measurement(data, "temperature", "wmoUnit:degC")
    rain_mm, rain_error = measurement(data, "precipitationLastHour", "wmoUnit:mm")
    return {
        "wind_kmh": wind_kmh,
        "wind_mph": None if wind_kmh is None else kmh_to_mph(wind_kmh),
        "temperature_c": temperature_c,
        "temperature_f": None if temperature_c is None else celsius_to_fahrenheit(temperature_c),
        "precipitation_last_hour_mm": rain_mm,
        "errors": [error for error in (wind_error, temperature_error, rain_error) if error],
    }


def rule_identity(rule: dict[str, Any]) -> str:
    return "|".join((str(rule.get("reg", "")), str(rule.get("id", "")), str(rule.get("quote", ""))))


def rule_reference(rule: dict[str, Any], reason: str | None = None) -> dict[str, Any]:
    reference = {
        "key": rule_identity(rule),
        "reg": rule.get("reg"),
        "product": rule.get("product"),
        "rule": rule.get("id"),
        "page": rule.get("page"),
        "param": rule.get("param"),
        "quote": rule.get("quote"),
    }
    if reason is not None:
        reference["reason"] = reason
    return reference


def not_checkable_reason(rule: dict[str, Any]) -> str | None:
    if windows.tank_composition_clause(rule):
        return "minimum night temperature and tank composition need a full night record, not one ASOS hour"
    param = rule.get("param")
    if param == "temperature_inversion":
        return "ASOS does not determine whether a temperature inversion was present at the field"
    if param in ("rain_free_hours", "rainfall_expected"):
        return "rainfast interval needs observations after application; precipitationLastHour at H covers the prior hour"
    if param == "wind_speed_mph":
        upper, _, lower, _ = windows.wind_limits(rule)
        if upper is None and lower is None:
            return "the acting wind clause has no machine-readable wind bound"
        return None
    if param == "air_temperature_f" and rule.get("value") is not None and rule.get("op") in windows.SYMBOL:
        return None
    return f"{param} is a field condition ASOS cannot decide from this observation"


def not_checkable_clauses(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clauses: dict[str, dict[str, Any]] = {}
    for rule in rules:
        if rule.get("modality") == "ADVISORY":
            continue
        reason = not_checkable_reason(rule)
        if reason is not None:
            clauses[rule_identity(rule)] = rule_reference(rule, reason)
    return [clauses[key] for key in sorted(clauses)]


def check_permitted_rules(rules: list[dict[str, Any]], weather: dict[str, Any]) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    not_checkable: list[str] = []
    for rule in rules:
        if rule.get("modality") == "ADVISORY":
            continue
        unavailable = not_checkable_reason(rule)
        if unavailable is not None:
            not_checkable.append(rule_identity(rule))
            continue
        reference = rule_reference(rule)
        if rule["param"] == "wind_speed_mph":
            observed = weather["wind_mph"]
            if observed is None:
                missing.append({**reference, "measurement": "windSpeed", "reason": "observed wind is unavailable"})
                continue
            upper, upper_out, lower, lower_out = windows.wind_limits(rule)
            upper_broke = upper is not None and (observed > upper or (upper_out and observed == upper))
            lower_broke = lower is not None and (observed < lower or (lower_out and observed == lower))
            checks.append(
                {
                    **reference,
                    "status": "broke" if upper_broke or lower_broke else "held",
                    "observed": {
                        "value": round(observed, 6),
                        "unit": "mph",
                        "source_value": weather["wind_kmh"],
                        "source_unit": "km/h",
                    },
                    "limit": {
                        "upper_mph": upper,
                        "upper_inclusive": None if upper is None else not upper_out,
                        "lower_mph": lower,
                        "lower_inclusive": None if lower is None else not lower_out,
                    },
                }
            )
        elif rule["param"] == "air_temperature_f":
            observed = weather["temperature_f"]
            if observed is None:
                missing.append({**reference, "measurement": "temperature", "reason": "observed temperature is unavailable"})
                continue
            condition_active = windows.holds(observed, rule["op"], float(rule["value"]))
            checks.append(
                {
                    **reference,
                    "status": "broke" if condition_active else "held",
                    "observed": {
                        "value": round(observed, 6),
                        "unit": "F",
                        "source_value": weather["temperature_c"],
                        "source_unit": "degC",
                    },
                    "limit": {"op": rule["op"], "value_f": rule["value"]},
                }
            )
    broke = any(check["status"] == "broke" for check in checks)
    if broke:
        outcome = "broke"
    elif missing:
        outcome = "skipped_missing_measurement"
    elif checks:
        outcome = "held"
    else:
        outcome = "not_checkable"
    return {
        "outcome": outcome,
        "checks": checks,
        "missing_measurements": missing,
        "not_checkable_rule_keys": sorted(set(not_checkable)),
    }


def empty_counts() -> dict[str, Any]:
    return {
        "hours_considered": 0,
        "evaluated_hours": 0,
        "permitted_a_day_ahead": 0,
        "held": 0,
        "broke": 0,
        "not_checkable_only": 0,
        "skipped": {"no_obs": 0, "no_issuance": 0, "missing_measurement": 0},
        "breaks": {},
    }


def add_breaks(counts: dict[str, Any], checks: list[dict[str, Any]]) -> None:
    for check in checks:
        if check["status"] != "broke":
            continue
        key = check["key"]
        current = counts["breaks"].setdefault(
            key,
            {
                "key": key,
                "reg": check["reg"],
                "product": check["product"],
                "rule": check["rule"],
                "param": check["param"],
                "count": 0,
                "observed_min": check["observed"]["value"],
                "observed_max": check["observed"]["value"],
                "unit": check["observed"]["unit"],
                "limit": check["limit"],
            },
        )
        current["count"] += 1
        current["observed_min"] = min(current["observed_min"], check["observed"]["value"])
        current["observed_max"] = max(current["observed_max"], check["observed"]["value"])


def add_permitted_outcome(counts: dict[str, Any], result: dict[str, Any]) -> None:
    counts["permitted_a_day_ahead"] += 1
    outcome = result["outcome"]
    if outcome == "held":
        counts["held"] += 1
    elif outcome == "broke":
        counts["broke"] += 1
        add_breaks(counts, result["checks"])
    elif outcome == "skipped_missing_measurement":
        counts["skipped"]["missing_measurement"] += 1
    else:
        counts["not_checkable_only"] += 1


def merge_counts(values: list[dict[str, Any]]) -> dict[str, Any]:
    merged = empty_counts()
    for counts in values:
        for key in ("hours_considered", "evaluated_hours", "permitted_a_day_ahead", "held", "broke", "not_checkable_only"):
            merged[key] += counts[key]
        for key in merged["skipped"]:
            merged["skipped"][key] += counts["skipped"][key]
        for item in counts["breaks"].values():
            current = merged["breaks"].get(item["key"])
            if current is None:
                merged["breaks"][item["key"]] = dict(item)
                continue
            current["count"] += item["count"]
            current["observed_min"] = min(current["observed_min"], item["observed_min"])
            current["observed_max"] = max(current["observed_max"], item["observed_max"])
    return merged


def public_counts(counts: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in counts.items() if key != "breaks"} | {"breaks": [counts["breaks"][key] for key in sorted(counts["breaks"])]}


def load_scenarios() -> dict[str, dict[str, Any]]:
    products: dict[str, dict[str, Any]] = {}
    for registration in REGISTRATIONS:
        product, rules, skipped = windows.load_rules(registration)
        products[registration] = {
            "key": registration,
            "registrations": [registration],
            "product": product,
            "rules": rules,
            "topic_skipped": skipped,
        }
    tank_rules = [rule for registration in REGISTRATIONS for rule in products[registration]["rules"]]
    return {
        "tank_mix": {
            "key": "tank_mix",
            "registrations": list(REGISTRATIONS),
            "product": "Folex + FreeFall + Super Boll tank mix",
            "rules": tank_rules,
            "topic_skipped": [item for registration in REGISTRATIONS for item in products[registration]["topic_skipped"]],
        },
        **products,
    }


def hour_range(first: dt.datetime, last: dt.datetime) -> list[dt.datetime]:
    current = floor_hour(first)
    end = floor_hour(last)
    hours = []
    while current <= end:
        hours.append(current)
        current += dt.timedelta(hours=1)
    return hours


def exact_command(argv: list[str]) -> str:
    return "python " + " ".join(shlex.quote(value) for value in argv)


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        handle.write("\n")


def build_headline(results: dict[str, Any]) -> str:
    tank = results["tank_mix"]["pooled"]
    tank_checked = tank["held"] + tank["broke"]
    product_parts = []
    small = []
    if tank_checked < 30:
        small.append("tank mix")
    for registration in REGISTRATIONS:
        pooled = results[registration]["pooled"]
        checked = pooled["held"] + pooled["broke"]
        product_parts.append(f"{registration} {pooled['held']} of {checked}")
        if checked < 30:
            small.append(registration)
    headline = (
        "When Labelhand said go a day ahead, the label limits an ASOS station can check held in "
        f"{tank['held']} of {tank_checked} checked hours (tank mix), " + ", ".join(product_parts) + "."
    )
    if tank["skipped"]["missing_measurement"]:
        headline += f" {tank['skipped']['missing_measurement']} additional permitted tank-mix hours lacked observed wind."
    if small:
        headline += " Sample size is below 30 for " + ", ".join(small) + "."
    return headline


def run_checkback(recorded: pathlib.Path, command: str, generated_utc: str) -> dict[str, Any]:
    hourly_by_point, hourly_stats = load_hourly(recorded)
    observations_by_point, observation_stats = load_observations(recorded)
    if not hourly_by_point:
        raise SystemExit("no valid recorded hourly forecasts")

    point_cache = json.loads(windows.CACHE.read_text(encoding="utf-8"))
    scenarios = load_scenarios()
    counts = {key: {point: empty_counts() for point in sorted(hourly_by_point)} for key in scenarios}
    details: list[dict[str, Any]] = []
    station_usage: dict[tuple[str, str], set[str]] = defaultdict(set)
    assigned_total = outside_total = 0

    all_hourly = [issuance for values in hourly_by_point.values() for issuance in values]
    recorded_first = min(item["fetched"] for item in all_hourly)
    recorded_last = max(item["fetched"] for item in all_hourly)

    for point in sorted(hourly_by_point):
        if point not in point_cache:
            raise SystemExit(f"point cache has no entry for {point}")
        point_observations, outside = assign_observations(observations_by_point.get(point, []))
        assigned_total += len(point_observations)
        outside_total += outside
        point_issuances = hourly_by_point[point]
        point_first = min(item["fetched"] for item in point_issuances)
        point_last = max(item["fetched"] for item in point_issuances)
        lat = float(point_cache[point]["lat"])
        lon = float(point_cache[point]["lon"])
        evaluation_cache: dict[tuple[str, str], dict[dt.datetime, dict[str, Any]]] = {}

        for hour in hour_range(point_first, point_last):
            row: dict[str, Any] = {"point": point, "hour_utc": hour.isoformat()}
            for scenario_counts in counts.values():
                scenario_counts[point]["hours_considered"] += 1
            observation = point_observations.get(hour)
            if observation is None:
                row["skip_reason"] = "no_obs"
                for scenario_counts in counts.values():
                    scenario_counts[point]["skipped"]["no_obs"] += 1
                details.append(row)
                continue

            target = hour - dt.timedelta(hours=24)
            issuance = closest_issuance(point_issuances, target)
            if issuance is None:
                row["skip_reason"] = "no_issuance"
                row["observation_timestamp"] = observation["timestamp"]
                for scenario_counts in counts.values():
                    scenario_counts[point]["skipped"]["no_issuance"] += 1
                details.append(row)
                continue
            if hour not in issuance["period_hours"]:
                row["skip_reason"] = "no_issuance"
                row["observation_timestamp"] = observation["timestamp"]
                row["issuance_fetched_utc"] = issuance["fetched_utc"]
                for scenario_counts in counts.values():
                    scenario_counts[point]["skipped"]["no_issuance"] += 1
                details.append(row)
                continue

            station_usage[(observation["station_id"], observation["station_name"])].add(point)
            weather = observed_weather(observation["data"])
            row.update(
                {
                    "observation": {
                        "timestamp": observation["timestamp"],
                        "stationId": observation["station_id"],
                        "stationName": observation["station_name"],
                        "weather": weather,
                    },
                    "issuance": {
                        "fetched_utc": issuance["fetched_utc"],
                        "target_utc": target.isoformat(),
                        "distance_minutes": round(abs(issuance["fetched"] - target).total_seconds() / 60, 3),
                    },
                    "scenarios": {},
                }
            )

            for scenario_key, scenario in scenarios.items():
                cache_key = (scenario_key, issuance["path"])
                evaluated = evaluation_cache.get(cache_key)
                if evaluated is None:
                    output = windows.evaluate(scenario["rules"], issuance["periods"], lat, lon, len(issuance["periods"]))
                    evaluated = {parse_datetime(item["start"], "planner hour start"): item for item in output}
                    evaluation_cache[cache_key] = evaluated
                planner_hour = evaluated.get(hour)
                if planner_hour is None:
                    raise RuntimeError(f"planner omitted {hour.isoformat()} from {issuance['path']}")
                scenario_counts = counts[scenario_key][point]
                scenario_counts["evaluated_hours"] += 1
                scenario_detail: dict[str, Any] = {"planner_state": planner_hour["state"]}
                if planner_hour["state"] == "PERMITTED":
                    result = check_permitted_rules(scenario["rules"], weather)
                    add_permitted_outcome(scenario_counts, result)
                    scenario_detail.update(result)
                else:
                    scenario_detail["outcome"] = "not_permitted"
                row["scenarios"][scenario_key] = scenario_detail
            details.append(row)

    observation_stats["assigned_observation_hours"] = assigned_total
    observation_stats["observations_outside_hour_tolerance"] = outside_total
    results: dict[str, Any] = {}
    for scenario_key, scenario in scenarios.items():
        point_results = {point: public_counts(counts[scenario_key][point]) for point in sorted(counts[scenario_key])}
        pooled = public_counts(merge_counts(list(counts[scenario_key].values())))
        results[scenario_key] = {
            "registrations": scenario["registrations"],
            "product": scenario["product"],
            "pooled": pooled,
            "points": point_results,
            "not_checkable_clauses": not_checkable_clauses(scenario["rules"]),
            "topic_skipped_rules": scenario["topic_skipped"],
        }

    headline = build_headline(results)
    stations = [{"stationId": key[0], "stationName": key[1], "points": sorted(points)} for key, points in sorted(station_usage.items())]
    return {
        "generated_utc": generated_utc,
        "recorded_span": {
            "first": recorded_first.isoformat(),
            "last": recorded_last.isoformat(),
        },
        "command": command,
        "stations": stations,
        "input_counts": hourly_stats | observation_stats,
        "headline": headline,
        "tank_mix": results["tank_mix"],
        "products": {registration: results[registration] for registration in REGISTRATIONS},
        "details": details,
    }


def summary_from_report(report: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in report.items() if key != "details"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recorded", required=True, type=pathlib.Path)
    parser.add_argument("--detail-out", type=pathlib.Path)
    parser.add_argument("--summary-out", type=pathlib.Path, default=ROOT / "web" / "public" / "data" / "checkback.json")
    args = parser.parse_args(argv)
    now = dt.datetime.now(dt.UTC)
    detail_out = args.detail_out or ROOT / "eval" / "results" / f"checkback-{now.date().isoformat()}.json"
    command = exact_command([str(pathlib.Path(__file__).relative_to(ROOT)), *(argv if argv is not None else sys.argv[1:])])
    report = run_checkback(args.recorded, command, now.isoformat(timespec="seconds"))
    write_json(detail_out, report)
    write_json(args.summary_out, summary_from_report(report))
    print(report["headline"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
