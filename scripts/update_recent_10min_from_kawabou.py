from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests


KAWABOU_BASE = "https://www.river.go.jp/kawabou"
DEFAULT_OFC_CD = "21271"
DEFAULT_ITMKND_CD = "4"
DEFAULT_OBS_CD = "7"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
JST = ZoneInfo("Asia/Tokyo")


@dataclass(frozen=True)
class FetchResult:
    payload: dict[str, Any]
    source_url: str
    source_slot: datetime
    errors: list[str]


def station_code(ofc_cd: str, itmknd_cd: str, obs_cd: str) -> str:
    return f"{int(ofc_cd):05d}{int(itmknd_cd):03d}{int(obs_cd):05d}"


def round_down_to_10_minutes(value: datetime) -> datetime:
    return value.replace(minute=(value.minute // 10) * 10, second=0, microsecond=0)


def parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(JST)
    text = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=JST)
    return dt.astimezone(JST)


def candidate_slots(now: datetime, steps: int) -> list[datetime]:
    start = round_down_to_10_minutes(now.astimezone(JST))
    return [start - timedelta(minutes=10 * i) for i in range(steps)]


def tmlist_url(slot: datetime, code: str) -> str:
    return f"{KAWABOU_BASE}/file/files/tmlist/stg/{slot:%Y%m%d}/{slot:%H%M}/{code}.json"


def parse_kawabou_time(value: str) -> datetime:
    for fmt in ("%Y/%m/%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=JST)
        except ValueError:
            continue
    raise ValueError(f"unsupported kawabou timestamp: {value!r}")


def parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= -9999:
        return None
    return parsed


def is_missing_code(value: Any) -> bool:
    if value in (None, ""):
        return False
    try:
        return int(value) >= 128
    except (TypeError, ValueError):
        return False


def output_timestamp(value: datetime) -> str:
    return value.astimezone(JST).strftime("%Y-%m-%dT%H:%M")


def parse_output_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=JST)


def parse_min10_values(payload: dict[str, Any]) -> list[dict[str, Any]]:
    records_by_ts: dict[str, dict[str, Any]] = {}
    rows = payload.get("min10Values") or []
    if not isinstance(rows, list):
        return []

    for row in rows:
        if not isinstance(row, dict):
            continue
        raw_time = row.get("obsTime")
        if not raw_time:
            continue
        try:
            observed_at = parse_kawabou_time(str(raw_time))
        except ValueError:
            continue

        quality_code = row.get("stgCcd")
        quality_flag = row.get("stgQmflg")
        value = parse_float(row.get("stg"))
        flag = ""
        if value is None or is_missing_code(quality_code):
            value = None
            flag = str(quality_flag or quality_code or "missing")

        ts = output_timestamp(observed_at)
        records_by_ts[ts] = {
            "timestamp": ts,
            "value": value,
            "flag": flag,
            "resolution": "10min",
            "quality_code": quality_code,
            "quality_flag": quality_flag,
            "over_level": row.get("stgOvlvl"),
            "change_10min": row.get("stg10mChg"),
        }

    return [records_by_ts[ts] for ts in sorted(records_by_ts)]


def clip_recent(records: list[dict[str, Any]], keep_hours: int) -> list[dict[str, Any]]:
    if not records:
        return []
    latest = parse_output_timestamp(records[-1]["timestamp"])
    threshold = latest - timedelta(hours=keep_hours)
    return [r for r in records if parse_output_timestamp(r["timestamp"]) >= threshold]


def fetch_latest_payload(
    session: requests.Session,
    code: str,
    now: datetime,
    probe_steps: int,
    timeout: int,
) -> FetchResult:
    errors: list[str] = []
    for slot in candidate_slots(now, probe_steps):
        url = tmlist_url(slot, code)
        try:
            response = session.get(url, timeout=timeout)
            if response.status_code == 404:
                errors.append(f"{slot:%Y-%m-%dT%H:%M}: 404")
                continue
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            errors.append(f"{slot:%Y-%m-%dT%H:%M}: {exc}")
            continue

        if not (payload.get("min10Values") or []):
            errors.append(f"{slot:%Y-%m-%dT%H:%M}: min10Values empty")
            continue
        return FetchResult(payload=payload, source_url=url, source_slot=slot, errors=errors)

    summary = "; ".join(errors[:10])
    if len(errors) > 10:
        summary += f"; ... ({len(errors)} attempts)"
    raise RuntimeError(f"no kawabou 10-minute payload found. tried {summary}")


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def is_same_observation_payload(path: Path, payload: dict[str, Any]) -> bool:
    if not path.exists():
        return False
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False

    existing_meta = existing.get("meta") or {}
    next_meta = payload.get("meta") or {}
    stable_meta_keys = ("station_code", "ofc_cd", "itmknd_cd", "obs_cd", "window_hours")
    return (
        existing.get("records") == payload.get("records")
        and all(existing_meta.get(key) == next_meta.get(key) for key in stable_meta_keys)
    )


def build_output_payload(
    source_payload: dict[str, Any],
    records: list[dict[str, Any]],
    code: str,
    args: argparse.Namespace,
    source_url: str | None,
    source_slot: datetime | None,
    errors: list[str] | None = None,
) -> dict[str, Any]:
    obs_value = source_payload.get("obsValue") or {}
    source_time = obs_value.get("obsTime") or records[-1]["timestamp"]
    return {
        "meta": {
            "source": "kawabou_tmlist",
            "station_code": code,
            "ofc_cd": args.ofc_cd,
            "itmknd_cd": args.itmknd_cd,
            "obs_cd": args.obs_cd,
            "record_count": len(records),
            "window_hours": args.keep_hours,
            "dataset_start": records[0]["timestamp"],
            "dataset_end": records[-1]["timestamp"],
            "latest_source_time": source_time,
            "source_slot_jst": output_timestamp(source_slot) if source_slot else None,
            "source_url": source_url,
            "last_fetch_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "probe_errors": errors or [],
            "notes": [
                "river.go.jp kawabou tmlist stg JSON の min10Values から作成。",
                "既存の1時間データに直近10分観測値を重ねるためのファイルです。",
            ],
        },
        "records": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="河川防災情報の10分観測値から recent_10min.json を更新します。")
    parser.add_argument("--ofc-cd", default=DEFAULT_OFC_CD)
    parser.add_argument("--itmknd-cd", default=DEFAULT_ITMKND_CD)
    parser.add_argument("--obs-cd", default=DEFAULT_OBS_CD)
    parser.add_argument("--station-code", default=None)
    parser.add_argument("--output", default="data/recent_10min.json")
    parser.add_argument("--keep-hours", type=int, default=24)
    parser.add_argument("--probe-steps", type=int, default=24)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--now", default=None, help="JST ISO timestamp for tests, e.g. 2026-07-09T12:04")
    parser.add_argument("--input", default=None, help="Local kawabou tmlist JSON fixture for tests")
    args = parser.parse_args()

    code = args.station_code or station_code(args.ofc_cd, args.itmknd_cd, args.obs_cd)

    if args.input:
        source_path = Path(args.input)
        source_payload = json.loads(source_path.read_text(encoding="utf-8"))
        source_url = f"local:{source_path}"
        source_slot = None
        errors: list[str] = []
    else:
        session = requests.Session()
        session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
            "Referer": f"{KAWABOU_BASE}/mb/tm?ofcCd={args.ofc_cd}&itmkndCd={args.itmknd_cd}&obsCd={args.obs_cd}",
        })
        result = fetch_latest_payload(session, code, parse_now(args.now), args.probe_steps, args.timeout)
        source_payload = result.payload
        source_url = result.source_url
        source_slot = result.source_slot
        errors = result.errors

    records = clip_recent(parse_min10_values(source_payload), args.keep_hours)
    if not records:
        raise SystemExit("no 10-minute records parsed from kawabou payload")

    output_path = Path(args.output)
    payload = build_output_payload(source_payload, records, code, args, source_url, source_slot, errors)
    if is_same_observation_payload(output_path, payload):
        print(f"unchanged {output_path} ({len(records)} records, latest {records[-1]['timestamp']})")
        return
    save_json(output_path, payload)
    print(f"saved {output_path} ({len(records)} records, latest {records[-1]['timestamp']})")


if __name__ == "__main__":
    main()
