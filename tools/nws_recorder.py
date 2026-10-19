"""Hourly NWS forecast + observation recorder for Labelhand replay evidence.

Why this exists: api.weather.gov serves only the current forecast. Replaying
"what did the forecast say at 6 AM on Oct 12" later is impossible unless we
record it now. Every run saves, per field point:
  - forecastHourly (every run)
  - raw gridpoint data (every 3rd hour; it carries wind gust, sky cover,
    precipitation probability and the fire-weather fields)
  - latest observation from the nearest ASOS station (every run)

Rules this script follows:
  - stdlib only (it runs from Task Scheduler with no virtualenv)
  - content-checked writes: a response is saved only if it parses as JSON
    and contains the expected fields; anything else is logged, never written
  - no personal data in the User-Agent
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "nws_recorded"
CACHE = ROOT / "data" / "nws_points_cache.json"
LOG = ROOT / "data" / "nws_recorder.log"
UA = "labelhand-hackathon-recorder/0.1 (github.com/StephenSook)"

# Approximate farmland points in ten major Georgia cotton counties. These are
# replay sample points, not anyone's field; real field polygons come later
# from USDA Crop Sequence Boundaries.
POINTS = {
    "tift": (31.40, -83.60),
    "worth": (31.50, -83.90),
    "ben_hill": (31.75, -83.30),
    "colquitt": (31.15, -83.85),
    "mitchell": (31.25, -84.25),
    "dooly": (32.10, -83.85),
    "coffee": (31.50, -82.95),
    "irwin": (31.58, -83.20),
    "berrien": (31.25, -83.30),
    "cook": (31.10, -83.45),
}


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{stamp} {msg}\n")


def fetch_json(url: str, attempts: int = 3, log_message: Callable[[str], None] = log) -> dict | None:
    last = ""
    for i in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
            return json.loads(body)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 + 3 * i)
    log_message(f"FETCH_FAIL {url} {last}")
    return None


def resolve_points(
    fetch: Callable[[str, int], dict | None] = fetch_json,
    log_message: Callable[[str], None] = log,
    cache_path: pathlib.Path = CACHE,
) -> dict:
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    changed = False
    for name, (lat, lon) in POINTS.items():
        if name in cache and "stations" in cache[name]:
            continue
        meta = fetch(f"https://api.weather.gov/points/{lat},{lon}", 3)
        props = meta.get("properties", {}) if isinstance(meta, dict) else {}
        needed = ("forecastHourly", "forecastGridData", "observationStations", "gridId")
        if not all(k in props for k in needed):
            log_message(f"POINT_UNRESOLVED {name}")
            continue
        stations = fetch(props["observationStations"], 3)
        feats = stations.get("features", []) if isinstance(stations, dict) else []
        station_ids = [f["properties"]["stationIdentifier"] for f in feats[:4]]
        station = station_ids[0] if station_ids else None
        cache[name] = {
            "stations": station_ids,
            "lat": lat,
            "lon": lon,
            "gridId": props["gridId"],
            "gridX": props.get("gridX"),
            "gridY": props.get("gridY"),
            "forecastHourly": props["forecastHourly"],
            "forecastGridData": props["forecastGridData"],
            "station": station,
        }
        changed = True
    if changed:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    return cache


def record_key(kind: str, name: str, now: dt.datetime) -> str:
    return f"nws_recorded/{now.strftime('%Y-%m-%d')}/{now.strftime('%H%M')}Z_{name}_{kind}.json.gz"


def encode_record(kind: str, name: str, payload: dict, now: dt.datetime) -> bytes:
    record = {"fetched_utc": now.isoformat(timespec="seconds"), "point": name, "kind": kind, "data": payload}
    encoded = json.dumps(record, separators=(",", ":")).encode("utf-8")
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as handle:
        handle.write(encoded)
    return output.getvalue()


def save(kind: str, name: str, payload: dict, now: dt.datetime) -> None:
    relative = pathlib.PurePosixPath(record_key(kind, name, now)).relative_to("nws_recorded")
    path = DATA.joinpath(*relative.parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_record(kind, name, payload, now))


def record_once(
    cache: dict,
    now: dt.datetime,
    fetch: Callable[[str, int], dict | None] = fetch_json,
    save_record: Callable[[str, str, dict, dt.datetime], None] = save,
    log_message: Callable[[str], None] = log,
) -> tuple[int, int]:
    ok = fail = 0

    def checked_save(kind: str, name: str, payload: dict) -> bool:
        try:
            save_record(kind, name, payload, now)
        except Exception as exc:
            log_message(f"SAVE_FAIL {kind} {name} {type(exc).__name__}: {exc}")
            return False
        return True

    for name, meta in cache.items():
        hourly = fetch(meta["forecastHourly"], 3)
        hprops = hourly.get("properties", {}) if isinstance(hourly, dict) else {}
        periods = hprops.get("periods", []) if isinstance(hprops, dict) else []
        if periods and isinstance(periods[0], dict) and "windSpeed" in periods[0] and "temperature" in periods[0]:
            if checked_save("hourly", name, hprops):
                ok += 1
            else:
                fail += 1
        else:
            log_message(f"BAD_CONTENT hourly {name}")
            fail += 1
        if now.hour % 3 == 0:
            grid = fetch(meta["forecastGridData"], 3)
            gprops = grid.get("properties", {}) if isinstance(grid, dict) else {}
            if "temperature" in gprops and "windSpeed" in gprops:
                if checked_save("grid", name, gprops):
                    ok += 1
                else:
                    fail += 1
            else:
                log_message(f"BAD_CONTENT grid {name}")
                fail += 1
        saved_obs = False
        for station in meta.get("stations") or ([meta["station"]] if meta.get("station") else []):
            obs = fetch(f"https://api.weather.gov/stations/{station}/observations/latest", 1)
            oprops = obs.get("properties", {}) if isinstance(obs, dict) else {}
            if "timestamp" in oprops:
                oprops["_station"] = station
                if checked_save("obs", name, oprops):
                    ok += 1
                    saved_obs = True
                    break
        if not saved_obs:
            log_message(f"BAD_CONTENT obs {name} (no station answered)")
            fail += 1
    return ok, fail


def main() -> int:
    now = dt.datetime.now(dt.UTC)
    cache = resolve_points()
    ok, fail = record_once(cache, now)
    log(f"RUN ok={ok} fail={fail} points={len(cache)}")
    return 0 if ok and not fail else (2 if ok else 1)


if __name__ == "__main__":
    sys.exit(main())
