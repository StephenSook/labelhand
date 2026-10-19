"""Run one NWS recording pass and rebuild today's season data in Object Storage."""

from __future__ import annotations

import copy
import datetime as dt
import json
import os
import sys
from typing import Any

import nws_recorder
import season_export

REGION = "eu-north1"
REQUIRED_ENV = (
    "RECORDER_BUCKET",
    "RECORDER_S3_ENDPOINT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
)


def create_s3_client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=os.environ["RECORDER_S3_ENDPOINT"],
        region_name=REGION,
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )


def missing_object(exc: Exception) -> bool:
    response = getattr(exc, "response", {})
    code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode") if isinstance(response, dict) else None
    return code in {"NoSuchKey", "NotFound", "404"} or status == 404


def body_bytes(body: Any) -> bytes:
    if isinstance(body, bytes):
        return body
    if hasattr(body, "read"):
        value = body.read()
        if isinstance(value, bytes):
            return value
    raise TypeError("S3 object body did not provide bytes")


def read_bytes(client, bucket: str, key: str) -> bytes:
    response = client.get_object(Bucket=bucket, Key=key)
    return body_bytes(response["Body"])


def read_json_optional(client, bucket: str, key: str) -> dict[str, Any] | None:
    try:
        value = json.loads(read_bytes(client, bucket, key))
    except Exception as exc:
        if missing_object(exc):
            return None
        raise
    if not isinstance(value, dict):
        raise TypeError(f"{key} is not a JSON object")
    return value


def list_hourly_keys(client, bucket: str, day: str) -> list[str]:
    prefix = f"nws_recorded/{day}/"
    keys: list[str] = []
    token: str | None = None
    while True:
        args = {"Bucket": bucket, "Prefix": prefix}
        if token:
            args["ContinuationToken"] = token
        response = client.list_objects_v2(**args)
        keys.extend(item["Key"] for item in response.get("Contents", []) if item["Key"].endswith("_hourly.json.gz"))
        if not response.get("IsTruncated"):
            return sorted(keys)
        token = response.get("NextContinuationToken")
        if not token:
            raise RuntimeError("truncated S3 listing did not include a continuation token")


def write_record(
    client,
    bucket: str,
    kind: str,
    name: str,
    payload: dict,
    recorded_at: dt.datetime,
) -> None:
    client.put_object(
        Bucket=bucket,
        Key=nws_recorder.record_key(kind, name, recorded_at),
        Body=nws_recorder.encode_record(kind, name, payload, recorded_at),
        ContentType="application/json",
        ContentEncoding="gzip",
    )


def update_index(
    existing: dict[str, Any] | None,
    previous_days: dict[str, dict[str, Any] | None],
    day_documents: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    index = copy.deepcopy(existing) if existing is not None else {"points": {}}
    points = index.setdefault("points", {})
    if not isinstance(points, dict):
        raise TypeError("season/index.json points is not an object")

    all_issuances = [issuance for document in day_documents.values() for issuance in document["issuances"]]
    fetched = [issuance["fetched_utc"] for issuance in all_issuances]
    first_new = min(fetched, key=dt.datetime.fromisoformat)
    last_new = max(fetched, key=dt.datetime.fromisoformat)
    day = next(iter(day_documents.values()))["day"]

    for point, document in day_documents.items():
        current = points.setdefault(point, {"days": [], "issuances": 0})
        if not isinstance(current, dict):
            raise TypeError(f"season/index.json point {point} is not an object")
        old_document = previous_days[point]
        old_count = len(old_document.get("issuances", [])) if old_document else 0
        old_total = current.get("issuances", 0)
        if not isinstance(old_total, int) or old_total < old_count:
            raise TypeError(f"season/index.json point {point} has an invalid issuance count")
        current["days"] = sorted(set(current.get("days", [])) | {day})
        current["issuances"] = old_total - old_count + len(document["issuances"])

    existing_span = index.get("recorded_span") if isinstance(index.get("recorded_span"), dict) else {}
    first_candidates = [first_new]
    last_candidates = [last_new]
    if existing_span.get("first"):
        first_candidates.append(existing_span["first"])
    if existing_span.get("last"):
        last_candidates.append(existing_span["last"])
    index["recorded_span"] = {
        "first": min(first_candidates, key=dt.datetime.fromisoformat),
        "last": max(last_candidates, key=dt.datetime.fromisoformat),
    }
    index["generated_utc"] = index["recorded_span"]["last"]
    return index


def rebuild_day(client, bucket: str, day: str) -> tuple[int, int]:
    keys = list_hourly_keys(client, bucket, day)
    records = [season_export.parse_hourly_bytes(read_bytes(client, bucket, key), key) for key in keys]
    documents = {point: season_export.build_day(records, point, day) for point in nws_recorder.POINTS}
    previous = {point: read_json_optional(client, bucket, f"season/{point}/{day}.json") for point in nws_recorder.POINTS}
    existing_index = read_json_optional(client, bucket, "season/index.json")
    index = update_index(existing_index, previous, documents)

    for point, document in documents.items():
        client.put_object(
            Bucket=bucket,
            Key=f"season/{point}/{day}.json",
            Body=season_export.encode_json(document),
            ContentType="application/json",
        )
    client.put_object(
        Bucket=bucket,
        Key="season/index.json",
        Body=season_export.encode_json(index),
        ContentType="application/json",
    )
    return len(keys), len(documents)


def run(client, bucket: str, now: dt.datetime) -> tuple[int, dict[str, int], list[str]]:
    diagnostics: list[str] = []
    errors: list[str] = []

    def job_log(message: str) -> None:
        diagnostics.append(message)

    def fetch(url: str, attempts: int = 3) -> dict | None:
        return nws_recorder.fetch_json(url, attempts, job_log)

    def save_record(kind: str, name: str, payload: dict, recorded_at: dt.datetime) -> None:
        write_record(client, bucket, kind, name, payload, recorded_at)

    cache = nws_recorder.resolve_points(fetch=fetch, log_message=job_log)
    missing = sorted(set(nws_recorder.POINTS) - set(cache))
    if missing:
        errors.append(f"POINTS_MISSING {','.join(missing)}")
    ok, fail = nws_recorder.record_once(cache, now, fetch=fetch, save_record=save_record, log_message=job_log)
    if fail:
        detail = diagnostics[-1] if diagnostics else "no detail"
        errors.append(f"RAW_FAIL count={fail} detail={detail}")

    hourly_objects = season_points = 0
    try:
        hourly_objects, season_points = rebuild_day(client, bucket, now.date().isoformat())
    except Exception as exc:
        errors.append(f"SEASON_FAIL {type(exc).__name__}: {exc}")

    counts = {
        "raw_ok": ok,
        "raw_fail": fail,
        "hourly_objects": hourly_objects,
        "season_points": season_points,
    }
    return (0 if not errors else 1), counts, errors


def main() -> int:
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        print(f"recorder_job status=failed missing_env={','.join(missing)}")
        return 1

    counts = {"raw_ok": 0, "raw_fail": 0, "hourly_objects": 0, "season_points": 0}
    messages: list[str] = []
    try:
        result, counts, messages = run(create_s3_client(), os.environ["RECORDER_BUCKET"], dt.datetime.now(dt.UTC))
    except Exception as exc:
        result = 1
        messages = [f"JOB_FAIL {type(exc).__name__}: {exc}"]
    first_error = " ".join(messages[0].split())[:240] if messages else "none"
    print(
        f"recorder_job status={'ok' if result == 0 else 'failed'} raw_ok={counts['raw_ok']} raw_fail={counts['raw_fail']} "
        f"hourly_objects={counts['hourly_objects']} season_points={counts['season_points']} errors={len(messages)} first_error={first_error}"
    )
    return result


if __name__ == "__main__":
    sys.exit(main())
