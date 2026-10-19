"""Season export tests use synthetic-shape records, not measured evidence."""

import gzip
import json

import season_export


def period(start, wind="5 mph", pop=10):
    return {
        "startTime": start,
        "isDaytime": True,
        "temperature": 72,
        "windSpeed": wind,
        "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": pop},
    }


def write_record(path, fetched, periods):
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "fetched_utc": fetched,
        "point": "test_point",
        "kind": "hourly",
        "data": {"periods": periods},
    }
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(record, handle)


def test_export_is_columnar_deterministic_and_preserves_raw_values(tmp_path):
    recorded = tmp_path / "recorded"
    source = recorded / "2026-10-05" / "0100Z_test_point_hourly.json.gz"
    write_record(
        source,
        "2026-10-05T01:00:00+00:00",
        [
            period("2026-10-05T00:00:00-04:00"),
            period("2026-10-05T02:00:00-04:00", "5 to 10 mph", None),
        ],
    )
    records, stats = season_export.scan_recorded(recorded)
    assert stats == {
        "hourly_files": 1,
        "valid_files": 1,
        "bad_files": 0,
        "bad_examples": [],
        "nonconsecutive": 1,
        "raw_wind_values": 1,
    }

    out = tmp_path / "out"
    season_export.write_export(records, out, 1)
    first = {path.relative_to(out): path.read_bytes() for path in sorted(out.rglob("*.json"))}
    season_export.write_export(records, out, 1)
    second = {path.relative_to(out): path.read_bytes() for path in sorted(out.rglob("*.json"))}
    assert first == second

    day = json.loads((out / "test_point" / "2026-10-05.json").read_text(encoding="utf-8"))
    issuance = day["issuances"][0]
    assert issuance["wind_mph"] == [5, None]
    assert issuance["wind_raw"] == [None, "5 to 10 mph"]
    assert issuance["pop"] == [10, None]
    assert issuance["start_times"] == [
        "2026-10-05T00:00:00-04:00",
        "2026-10-05T02:00:00-04:00",
    ]


def test_bad_rate_above_two_percent_returns_nonzero_without_output(tmp_path):
    recorded = tmp_path / "recorded"
    good = recorded / "2026-10-05" / "0100Z_test_point_hourly.json.gz"
    write_record(good, "2026-10-05T01:00:00+00:00", [period("2026-10-05T00:00:00-04:00")])
    bad = recorded / "2026-10-05" / "0200Z_test_point_hourly.json.gz"
    bad.write_bytes(b"not gzip")
    out = tmp_path / "out"

    assert season_export.main(["--recorded", str(recorded), "--out", str(out)]) == 1
    assert not out.exists()
