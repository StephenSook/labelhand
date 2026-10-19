"""Export recorded NWS hourly forecasts as compact season data.

The recorder stores one gzip JSON envelope per point and issuance. This tool
keeps only the five fields consumed by the planner and groups issuances by
point and UTC fetch day.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import pathlib
import re
import sys
from collections import defaultdict
from typing import Any

SOURCE = "NWS forecastHourly recorded by tools/nws_recorder.py"
WIND_MPH = re.compile(r"^(\d+(?:\.\d+)?) mph$")
REQUIRED_PERIOD_FIELDS = (
    "startTime",
    "isDaytime",
    "temperature",
    "windSpeed",
    "probabilityOfPrecipitation",
)


class BadHourlyFile(ValueError):
    """A recorded hourly file cannot be safely exported."""


def parse_datetime(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise BadHourlyFile(f"{field} is not a non-empty string")
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as exc:
        raise BadHourlyFile(f"{field} is not RFC3339: {value!r}") from exc
    if parsed.tzinfo is None:
        raise BadHourlyFile(f"{field} has no UTC offset: {value!r}")
    return parsed


def numeric_or_none(value: Any, field: str) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BadHourlyFile(f"{field} is not numeric or null")
    return value


def parse_wind(value: Any) -> tuple[int | float | None, str | None, bool]:
    if value is None:
        return None, None, True
    if not isinstance(value, str):
        raise BadHourlyFile("windSpeed is not a string or null")
    match = WIND_MPH.fullmatch(value)
    if not match:
        return None, value, True
    number = float(match.group(1))
    return (int(number) if number.is_integer() else number), None, False


def parse_periods(periods: Any) -> tuple[dict[str, Any], bool, int]:
    if not isinstance(periods, list) or not periods:
        raise BadHourlyFile("data.periods is not a non-empty array")

    starts: list[str] = []
    parsed_starts: list[dt.datetime] = []
    is_daytime: list[bool] = []
    temperatures: list[int | float | None] = []
    winds: list[int | float | None] = []
    wind_raw: list[str | None] = []
    pops: list[int | None] = []
    has_raw_wind = False

    for index, period in enumerate(periods):
        if not isinstance(period, dict):
            raise BadHourlyFile(f"period {index} is not an object")
        missing = [field for field in REQUIRED_PERIOD_FIELDS if field not in period]
        if missing:
            raise BadHourlyFile(f"period {index} is missing {', '.join(missing)}")

        start = period["startTime"]
        parsed_start = parse_datetime(start, f"period {index} startTime")
        daytime = period["isDaytime"]
        if not isinstance(daytime, bool):
            raise BadHourlyFile(f"period {index} isDaytime is not boolean")
        temperature = numeric_or_none(period["temperature"], f"period {index} temperature")
        wind, raw, wind_is_raw = parse_wind(period["windSpeed"])
        probability = period["probabilityOfPrecipitation"]
        if not isinstance(probability, dict) or "value" not in probability:
            raise BadHourlyFile(f"period {index} probabilityOfPrecipitation has no value")
        pop = probability["value"]
        if pop is not None and (isinstance(pop, bool) or not isinstance(pop, int)):
            raise BadHourlyFile(f"period {index} precipitation probability is not integer or null")

        starts.append(start)
        parsed_starts.append(parsed_start)
        is_daytime.append(daytime)
        temperatures.append(temperature)
        winds.append(wind)
        wind_raw.append(raw)
        pops.append(pop)
        has_raw_wind = has_raw_wind or wind_is_raw

    consecutive = all(current - previous == dt.timedelta(hours=1) for previous, current in zip(parsed_starts, parsed_starts[1:], strict=False))
    expandable = consecutive and all(start == (parsed_starts[0] + dt.timedelta(hours=index)).isoformat() for index, start in enumerate(starts))

    issuance: dict[str, Any] = {
        "first_start": starts[0],
        "hours": len(periods),
        "is_daytime": is_daytime,
        "pop": pops,
        "temperature_f": temperatures,
        "wind_mph": winds,
    }
    if not expandable:
        issuance["start_times"] = starts
    if has_raw_wind:
        issuance["wind_raw"] = wind_raw
    return issuance, consecutive, sum(value is None for value in winds)


def parse_hourly_file(path: pathlib.Path) -> dict[str, Any]:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BadHourlyFile(f"cannot read gzip JSON: {type(exc).__name__}: {exc}") from exc
    if not isinstance(record, dict):
        raise BadHourlyFile("record envelope is not an object")
    if record.get("kind") != "hourly":
        raise BadHourlyFile("record kind is not hourly")
    point = record.get("point")
    if not isinstance(point, str) or not point:
        raise BadHourlyFile("point is not a non-empty string")
    fetched_value = record.get("fetched_utc")
    fetched = parse_datetime(fetched_value, "fetched_utc")
    data = record.get("data")
    if not isinstance(data, dict):
        raise BadHourlyFile("data is not an object")
    periods = data.get("periods")
    if periods is None and isinstance(data.get("properties"), dict):
        periods = data["properties"].get("periods")
    issuance, consecutive, raw_winds = parse_periods(periods)
    issuance["fetched_utc"] = fetched_value
    return {
        "point": point,
        "fetched": fetched,
        "fetched_utc": fetched_value,
        "issuance": issuance,
        "consecutive": consecutive,
        "raw_winds": raw_winds,
        "path": path,
    }


def scan_recorded(recorded: pathlib.Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    paths = sorted(recorded.rglob("*_hourly.json.gz"))
    records: list[dict[str, Any]] = []
    bad: list[dict[str, str]] = []
    for path in paths:
        try:
            records.append(parse_hourly_file(path))
        except BadHourlyFile as exc:
            bad.append({"file": str(path), "error": str(exc)})
    stats = {
        "hourly_files": len(paths),
        "valid_files": len(records),
        "bad_files": len(bad),
        "bad_examples": bad[:5],
        "nonconsecutive": sum(not record["consecutive"] for record in records),
        "raw_wind_values": sum(record["raw_winds"] for record in records),
    }
    return records, stats


def select_cadence(records: list[dict[str, Any]], cadence_hours: int) -> list[dict[str, Any]]:
    if cadence_hours == 1:
        return records
    selected = [record for record in records if record["fetched"].astimezone(dt.UTC).hour % cadence_hours == 0]
    return selected or records[:1]


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        handle.write("\n")


def write_export(
    records: list[dict[str, Any]],
    out: pathlib.Path,
    cadence_hours: int,
) -> dict[str, Any]:
    if not records:
        raise BadHourlyFile("no valid hourly files were found")
    ordered = sorted(records, key=lambda record: (record["point"], record["fetched"], str(record["path"])))
    by_point: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in ordered:
        by_point[record["point"]].append(record)

    point_index: dict[str, dict[str, Any]] = {}
    written_issuances = 0
    for point in sorted(by_point):
        selected = select_cadence(by_point[point], cadence_hours)
        by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in selected:
            day = record["fetched"].astimezone(dt.UTC).date().isoformat()
            by_day[day].append(record["issuance"])
        days = sorted(by_day)
        for day in days:
            write_json(
                out / point / f"{day}.json",
                {
                    "day": day,
                    "issuances": by_day[day],
                    "point": point,
                    "source": SOURCE,
                },
            )
        written_issuances += len(selected)
        point_index[point] = {"days": days, "issuances": len(selected)}

    first = min(records, key=lambda record: record["fetched"])
    last = max(records, key=lambda record: record["fetched"])
    index = {
        "generated_utc": last["fetched_utc"],
        "points": point_index,
        "recorded_span": {"first": first["fetched_utc"], "last": last["fetched_utc"]},
    }
    write_json(out / "index.json", index)
    output_bytes = sum(path.stat().st_size for path in out.rglob("*.json"))
    return {"written_issuances": written_issuances, "output_bytes": output_bytes}


def print_summary(stats: dict[str, Any], cadence_hours: int, written: dict[str, Any] | None) -> None:
    parts = [
        f"hourly={stats['hourly_files']}",
        f"valid={stats['valid_files']}",
        f"bad={stats['bad_files']}",
        f"nonconsecutive={stats['nonconsecutive']}",
        f"raw_wind_values={stats['raw_wind_values']}",
        f"cadence_hours={cadence_hours}",
    ]
    if written is not None:
        parts.extend(
            [
                f"written_issuances={written['written_issuances']}",
                f"output_bytes={written['output_bytes']}",
            ]
        )
    print("season_export " + " ".join(parts))
    for bad in stats["bad_examples"]:
        print(f"bad_file {bad['file']}: {bad['error']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recorded", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--cadence-hours", type=int, choices=(1, 2, 3), default=1)
    args = parser.parse_args(argv)

    records, stats = scan_recorded(args.recorded)
    bad_rate = stats["bad_files"] / stats["hourly_files"] if stats["hourly_files"] else 1.0
    if bad_rate > 0.02:
        print_summary(stats, args.cadence_hours, None)
        print(f"season_export refused output: bad hourly rate {bad_rate:.2%} exceeds 2.00%")
        return 1
    try:
        written = write_export(records, args.out, args.cadence_hours)
    except BadHourlyFile as exc:
        print_summary(stats, args.cadence_hours, None)
        print(f"season_export refused output: {exc}")
        return 1
    print_summary(stats, args.cadence_hours, written)
    return 0


if __name__ == "__main__":
    sys.exit(main())
