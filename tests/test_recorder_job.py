"""Recorder job tests use synthetic NWS-shape records, not measured evidence."""

import datetime as dt
import gzip
import io
import json

import nws_recorder
from recorder_job import run as recorder_job


def period(start):
    return {
        "startTime": start,
        "isDaytime": True,
        "temperature": 72,
        "windSpeed": "5 mph",
        "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": 10},
    }


def season_day(point, day, count):
    return {
        "day": day,
        "issuances": [{} for _ in range(count)],
        "point": point,
        "source": "test fixture",
    }


class MissingObject(Exception):
    response = {"Error": {"Code": "NoSuchKey"}, "ResponseMetadata": {"HTTPStatusCode": 404}}


class FakeS3:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.puts = []

    def put_object(self, **kwargs):
        self.puts.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise MissingObject()
        return {"Body": io.BytesIO(self.objects[Key])}

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        del Bucket, ContinuationToken
        keys = sorted(key for key in self.objects if key.startswith(Prefix))
        return {"Contents": [{"Key": key} for key in keys], "IsTruncated": False}


def test_pc_and_s3_writers_produce_identical_record_bytes(tmp_path, monkeypatch):
    now = dt.datetime(2026, 10, 19, 23, 0, tzinfo=dt.UTC)
    payload = {"periods": [period("2026-10-19T19:00:00-04:00")]}
    monkeypatch.setattr(nws_recorder, "DATA", tmp_path / "nws_recorded")
    nws_recorder.save("hourly", "tift", payload, now)

    client = FakeS3()
    recorder_job.write_record(client, "test", "hourly", "tift", payload, now)
    local = tmp_path / "nws_recorded" / "2026-10-19" / "2300Z_tift_hourly.json.gz"
    assert local.read_bytes() == client.puts[0]["Body"]
    assert gzip.decompress(local.read_bytes()) == gzip.decompress(nws_recorder.encode_record("hourly", "tift", payload, now))


def test_rebuild_day_uses_hourly_objects_and_replaces_current_day_count(monkeypatch):
    day = "2026-10-19"
    points = {"tift": (31.4, -83.6), "worth": (31.5, -83.9)}
    monkeypatch.setattr(nws_recorder, "POINTS", points)
    objects = {}
    for point in points:
        for hour in (1, 2):
            now = dt.datetime(2026, 10, 19, hour, 0, tzinfo=dt.UTC)
            objects[nws_recorder.record_key("hourly", point, now)] = nws_recorder.encode_record("hourly", point, {"periods": [period(f"2026-10-19T{hour:02d}:00:00+00:00")]}, now)
        objects[f"season/{point}/2026-10-18.json"] = json.dumps(season_day(point, "2026-10-18", 24)).encode()
        objects[f"season/{point}/{day}.json"] = json.dumps(season_day(point, day, 1)).encode()
    objects["nws_recorded/2026-10-19/0100Z_tift_grid.json.gz"] = b"ignored"
    objects["season/index.json"] = json.dumps(
        {
            "generated_utc": "2026-10-18T23:00:00+00:00",
            "points": {
                "tift": {"days": ["2026-10-18", day], "issuances": 25},
                "worth": {"days": ["2026-10-18", day], "issuances": 25},
            },
            "recorded_span": {"first": "2026-10-18T00:00:00+00:00", "last": "2026-10-18T23:00:00+00:00"},
        }
    ).encode()
    client = FakeS3(objects)

    assert recorder_job.rebuild_day(client, "test", day) == (4, 2)
    tift = json.loads(client.objects[f"season/tift/{day}.json"])
    index = json.loads(client.objects["season/index.json"])
    assert len(tift["issuances"]) == 2
    assert index["points"]["tift"] == {
        "days": ["2026-10-18", day],
        "issuances": 26,
        "issuances_by_day": {"2026-10-18": 24, day: 2},
    }
    assert index["recorded_span"] == {
        "first": "2026-10-18T00:00:00+00:00",
        "last": "2026-10-19T02:00:00+00:00",
    }


def test_s3_region_comes_from_the_nebius_endpoint():
    assert recorder_job.region_from_endpoint("https://storage.us-central1.nebius.cloud") == "us-central1"
    assert recorder_job.region_from_endpoint("https://storage.eu-north1.nebius.cloud/") == "eu-north1"
    try:
        recorder_job.region_from_endpoint("https://example.com")
    except ValueError:
        pass
    else:
        raise AssertionError("a non-Nebius endpoint must be refused")


def test_rebuild_day_keeps_seeded_issuances_that_no_hourly_object_backs(monkeypatch):
    # The bucket is seeded from the committed season files; their raw hourly files are not in it.
    day = "2026-10-19"
    monkeypatch.setattr(nws_recorder, "POINTS", {"tift": (31.4, -83.6)})
    seeded = {
        "day": day,
        "point": "tift",
        "source": "committed season",
        "issuances": [
            {"fetched_utc": "2026-10-19T00:07:01+00:00", "periods": []},
            {"fetched_utc": "2026-10-19T01:07:01+00:00", "periods": []},
        ],
    }
    now = dt.datetime(2026, 10, 19, 2, 23, tzinfo=dt.UTC)
    objects = {
        nws_recorder.record_key("hourly", "tift", now): nws_recorder.encode_record("hourly", "tift", {"periods": [period("2026-10-19T02:00:00+00:00")]}, now),
        f"season/tift/{day}.json": json.dumps(seeded).encode(),
        "season/index.json": json.dumps(
            {
                "points": {"tift": {"days": [day], "issuances": 2}},
                "recorded_span": {"first": "2026-10-19T00:07:01+00:00", "last": "2026-10-19T01:07:01+00:00"},
            }
        ).encode(),
    }
    client = FakeS3(objects)

    recorder_job.rebuild_day(client, "test", day)

    tift = json.loads(client.objects[f"season/tift/{day}.json"])
    fetched = [issuance["fetched_utc"] for issuance in tift["issuances"]]
    assert fetched[:2] == ["2026-10-19T00:07:01+00:00", "2026-10-19T01:07:01+00:00"]
    assert len(fetched) == 3
    index = json.loads(client.objects["season/index.json"])
    assert index["points"]["tift"]["issuances_by_day"] == {day: 3}


def test_rebuild_day_retry_does_not_subtract_an_unindexed_day(monkeypatch):
    day = "2026-10-19"
    monkeypatch.setattr(nws_recorder, "POINTS", {"tift": (31.4, -83.6)})
    objects = {}
    for hour in (1, 2):
        now = dt.datetime(2026, 10, 19, hour, 0, tzinfo=dt.UTC)
        objects[nws_recorder.record_key("hourly", "tift", now)] = nws_recorder.encode_record(
            "hourly",
            "tift",
            {"periods": [period(f"2026-10-19T{hour:02d}:00:00+00:00")]},
            now,
        )
    objects["season/tift/2026-10-18.json"] = json.dumps(season_day("tift", "2026-10-18", 24)).encode()
    objects["season/index.json"] = json.dumps(
        {
            "generated_utc": "2026-10-18T23:00:00+00:00",
            "points": {"tift": {"days": ["2026-10-18"], "issuances": 24}},
            "recorded_span": {
                "first": "2026-10-18T00:00:00+00:00",
                "last": "2026-10-18T23:00:00+00:00",
            },
        }
    ).encode()
    client = FakeS3(objects)
    real_put = client.put_object
    fail_index_once = True

    def put_with_one_index_failure(**kwargs):
        nonlocal fail_index_once
        if kwargs["Key"] == "season/index.json" and fail_index_once:
            fail_index_once = False
            raise RuntimeError("synthetic index write failure")
        real_put(**kwargs)

    client.put_object = put_with_one_index_failure
    try:
        recorder_job.rebuild_day(client, "test", day)
    except RuntimeError as error:
        assert str(error) == "synthetic index write failure"
    else:
        raise AssertionError("first rebuild unexpectedly succeeded")

    assert f"season/tift/{day}.json" in client.objects
    assert recorder_job.rebuild_day(client, "test", day) == (2, 1)
    index = json.loads(client.objects["season/index.json"])
    assert index["points"]["tift"] == {
        "days": ["2026-10-18", day],
        "issuances": 26,
        "issuances_by_day": {"2026-10-18": 24, day: 2},
    }


def test_rebuild_day_retry_replaces_an_already_indexed_day_count(monkeypatch):
    day = "2026-10-19"
    monkeypatch.setattr(nws_recorder, "POINTS", {"tift": (31.4, -83.6)})
    objects = {
        "season/tift/2026-10-18.json": json.dumps(season_day("tift", "2026-10-18", 24)).encode(),
        f"season/tift/{day}.json": json.dumps(season_day("tift", day, 1)).encode(),
    }
    for hour in (1, 2):
        now = dt.datetime(2026, 10, 19, hour, 0, tzinfo=dt.UTC)
        objects[nws_recorder.record_key("hourly", "tift", now)] = nws_recorder.encode_record(
            "hourly",
            "tift",
            {"periods": [period(f"2026-10-19T{hour:02d}:00:00+00:00")]},
            now,
        )
    objects["season/index.json"] = json.dumps(
        {
            "generated_utc": "2026-10-19T01:00:00+00:00",
            "points": {"tift": {"days": ["2026-10-18", day], "issuances": 25}},
            "recorded_span": {
                "first": "2026-10-18T00:00:00+00:00",
                "last": "2026-10-19T01:00:00+00:00",
            },
        }
    ).encode()
    client = FakeS3(objects)
    real_put = client.put_object
    fail_index_once = True

    def put_with_one_index_failure(**kwargs):
        nonlocal fail_index_once
        if kwargs["Key"] == "season/index.json" and fail_index_once:
            fail_index_once = False
            raise RuntimeError("synthetic index write failure")
        real_put(**kwargs)

    client.put_object = put_with_one_index_failure
    try:
        recorder_job.rebuild_day(client, "test", day)
    except RuntimeError as error:
        assert str(error) == "synthetic index write failure"
    else:
        raise AssertionError("first rebuild unexpectedly succeeded")

    assert recorder_job.rebuild_day(client, "test", day) == (2, 1)
    index = json.loads(client.objects["season/index.json"])
    assert index["points"]["tift"] == {
        "days": ["2026-10-18", day],
        "issuances": 26,
        "issuances_by_day": {"2026-10-18": 24, day: 2},
    }


def test_s3_writer_uses_expected_key_and_metadata():
    now = dt.datetime(2026, 10, 19, 23, 0, tzinfo=dt.UTC)
    cache = {
        "tift": {
            "forecastHourly": "hourly",
            "forecastGridData": "grid",
            "stations": ["KMGR"],
        }
    }
    responses = {
        "hourly": {"properties": {"periods": [period("2026-10-19T23:00:00+00:00")]}},
        "obs": {"properties": {"timestamp": "2026-10-19T23:00:00+00:00"}},
    }

    def fetch(url, attempts=3):
        del attempts
        return responses["obs" if "observations" in url else url]

    client = FakeS3()

    def save_record(kind, name, payload, recorded_at):
        client.put_object(
            Bucket="test",
            Key=nws_recorder.record_key(kind, name, recorded_at),
            Body=nws_recorder.encode_record(kind, name, payload, recorded_at),
            ContentType="application/json",
            ContentEncoding="gzip",
        )

    assert nws_recorder.record_once(cache, now, fetch=fetch, save_record=save_record, log_message=lambda _: None) == (2, 0)
    assert [item["Key"] for item in client.puts] == [
        "nws_recorded/2026-10-19/2300Z_tift_hourly.json.gz",
        "nws_recorded/2026-10-19/2300Z_tift_obs.json.gz",
    ]
    assert all(item["ContentType"] == "application/json" and item["ContentEncoding"] == "gzip" for item in client.puts)


def test_job_fails_when_one_required_object_cannot_be_written(monkeypatch):
    now = dt.datetime(2026, 10, 19, 23, 0, tzinfo=dt.UTC)
    cache = {
        "tift": {
            "forecastHourly": "hourly",
            "forecastGridData": "grid",
            "stations": ["KMGR"],
        }
    }

    def fetch_json(url, attempts=3, log_message=None):
        del attempts, log_message
        if "observations" in url:
            return {"properties": {"timestamp": now.isoformat()}}
        return {"properties": {"periods": [period(now.isoformat())]}}

    monkeypatch.setattr(nws_recorder, "POINTS", {"tift": (31.4, -83.6)})
    monkeypatch.setattr(nws_recorder, "resolve_points", lambda **_: cache)
    monkeypatch.setattr(nws_recorder, "fetch_json", fetch_json)
    client = FakeS3()
    real_put = client.put_object

    def fail_observation(**kwargs):
        if "_obs.json.gz" in kwargs["Key"]:
            raise RuntimeError("synthetic write failure")
        real_put(**kwargs)

    client.put_object = fail_observation
    result, counts, errors = recorder_job.run(client, "test", now)

    assert result == 1
    assert counts == {"raw_ok": 1, "raw_fail": 1, "hourly_objects": 1, "season_points": 1}
    assert errors[0].startswith("RAW_FAIL count=1")
