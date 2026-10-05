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
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

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


def fetch_json(url: str, attempts: int = 3) -> dict | None:
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
    log(f"FETCH_FAIL {url} {last}")
    return None


def resolve_points() -> dict:
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    changed = False
    for name, (lat, lon) in POINTS.items():
        if name in cache and "stations" in cache[name]:
            continue
        meta = fetch_json(f"https://api.weather.gov/points/{lat},{lon}")
        props = (meta or {}).get("properties", {})
        needed = ("forecastHourly", "forecastGridData", "observationStations", "gridId")
        if not all(k in props for k in needed):
            log(f"POINT_UNRESOLVED {name}")
            continue
        stations = fetch_json(props["observationStations"])
        feats = (stations or {}).get("features", [])
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
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    return cache


def save(kind: str, name: str, payload: dict, now: dt.datetime) -> None:
    day = DATA / now.strftime("%Y-%m-%d")
    day.mkdir(parents=True, exist_ok=True)
    path = day / f"{now.strftime('%H%M')}Z_{name}_{kind}.json.gz"
    record = {"fetched_utc": now.isoformat(timespec="seconds"), "point": name, "kind": kind, "data": payload}
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(record, fh, separators=(",", ":"))


def main() -> int:
    now = dt.datetime.now(dt.UTC)
    cache = resolve_points()
    ok = fail = 0
    for name, meta in cache.items():
        hourly = fetch_json(meta["forecastHourly"])
        periods = (hourly or {}).get("properties", {}).get("periods", [])
        if periods and "windSpeed" in periods[0] and "temperature" in periods[0]:
            save("hourly", name, hourly["properties"], now)
            ok += 1
        else:
            log(f"BAD_CONTENT hourly {name}")
            fail += 1
        if now.hour % 3 == 0:
            grid = fetch_json(meta["forecastGridData"])
            gprops = (grid or {}).get("properties", {})
            if "temperature" in gprops and "windSpeed" in gprops:
                save("grid", name, gprops, now)
                ok += 1
            else:
                log(f"BAD_CONTENT grid {name}")
                fail += 1
        saved_obs = False
        for station in meta.get("stations") or ([meta["station"]] if meta.get("station") else []):
            obs = fetch_json(f"https://api.weather.gov/stations/{station}/observations/latest", attempts=1)
            oprops = (obs or {}).get("properties", {})
            if "timestamp" in oprops:
                oprops["_station"] = station
                save("obs", name, oprops, now)
                ok += 1
                saved_obs = True
                break
        if not saved_obs:
            log(f"BAD_CONTENT obs {name} (no station answered)")
            fail += 1
    log(f"RUN ok={ok} fail={fail} points={len(cache)}")
    return 0 if ok and not fail else (2 if ok else 1)


if __name__ == "__main__":
    sys.exit(main())
