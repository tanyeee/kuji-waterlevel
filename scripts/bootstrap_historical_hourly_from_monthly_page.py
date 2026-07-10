from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import requests

from update_recent_from_monthly_page import fetch_month_records


USER_AGENT = "Mozilla/5.0 (compatible; KujiWaterLevelBot/1.0)"


@dataclass(frozen=True)
class StationTarget:
    id: str
    name: str
    observation_name: str | None
    station_id: str
    output: Path


@dataclass(frozen=True)
class MonthTarget:
    station: StationTarget
    year: int
    month: int


def month_range(start_year: int, end_year: int, end_month: int) -> list[tuple[int, int]]:
    months: list[tuple[int, int]] = []
    for year in range(start_year, end_year + 1):
        last_month = end_month if year == end_year else 12
        for month in range(1, last_month + 1):
            months.append((year, month))
    return months


def load_config_targets(config_path: Path, output_root: Path | None = None) -> list[StationTarget]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    targets: list[StationTarget] = []
    for station in config.get("stations", []):
        hourly = station.get("hourly") or {}
        station_id = hourly.get("station_id")
        data_dir = station.get("data_dir")
        if not station_id or not data_dir:
            continue
        output = Path(data_dir) / "historical_hourly.json"
        if output_root:
            output = output_root / station["id"] / "historical_hourly.json"
        targets.append(StationTarget(
            id=station["id"],
            name=station.get("name", station["id"]),
            observation_name=station.get("observation_name"),
            station_id=str(station_id),
            output=output,
        ))
    return targets


def fetch_month(target: MonthTarget, timeout: int) -> tuple[MonthTarget, list[dict]]:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    records = fetch_month_records(session, target.station.station_id, target.year, target.month, timeout)
    payload = [{"timestamp": r.timestamp, "value": r.value, "flag": r.flag} for r in records]
    return target, payload


def save_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def build_payload(
    station: StationTarget,
    records: list[dict],
    start_year: int,
    end_year: int,
    end_month: int,
) -> dict:
    valid = [r for r in records if r.get("value") is not None]
    return {
        "meta": {
            "source": "monthly_page_dat_bootstrap",
            "station_id": station.station_id,
            "station_name": station.name,
            "observation_name": station.observation_name,
            "record_count": len(records),
            "valid_record_count": len(valid),
            "dataset_start": records[0]["timestamp"] if records else None,
            "dataset_end": records[-1]["timestamp"] if records else None,
            "valid_dataset_start": valid[0]["timestamp"] if valid else None,
            "valid_dataset_end": valid[-1]["timestamp"] if valid else None,
            "start_year": start_year,
            "end_year": end_year,
            "end_month": end_month,
            "last_fetch_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "notes": [
                "時刻水位月表の月別 dat から2016年以降の1時間データを初期構築。",
                "フラグ $, #, - または数値化できない値は value=null として保持。",
            ],
        },
        "records": records,
    }


def parse_hour_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="時刻水位月表から長期 historical_hourly.json を初期構築します。")
    parser.add_argument("--config", default="config/stations.json")
    parser.add_argument("--start-year", type=int, default=2016)
    parser.add_argument("--end-year", type=int, default=datetime.now().year)
    parser.add_argument("--end-month", type=int, default=datetime.now().month)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--output-root", default=None, help="テスト用。指定時は <output-root>/<station>/historical_hourly.json に保存します。")
    parser.add_argument("--include-future", action="store_true", help="当月ページに含まれる未来の未登録枠も保存します。通常は保存しません。")
    args = parser.parse_args()

    output_root = Path(args.output_root) if args.output_root else None
    stations = load_config_targets(Path(args.config), output_root)
    if not stations:
        raise SystemExit("no station targets configured")

    months = month_range(args.start_year, args.end_year, args.end_month)
    tasks = [MonthTarget(station=station, year=year, month=month) for station in stations for year, month in months]
    records_by_station: dict[str, dict[str, dict]] = {station.id: {} for station in stations}

    print(f"fetching {len(tasks)} station-month pages with {args.workers} workers")
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(fetch_month, task, args.timeout): task for task in tasks}
        for future in as_completed(futures):
            task = futures[future]
            try:
                _, records = future.result()
            except Exception as exc:
                raise RuntimeError(f"failed {task.station.id} {task.year}-{task.month:02d}: {exc}") from exc
            station_records = records_by_station[task.station.id]
            for record in records:
                station_records[record["timestamp"]] = record
            print(f"fetched {task.station.id} {task.year}-{task.month:02d} ({len(records)} records)")

    for station in stations:
        records = sorted(records_by_station[station.id].values(), key=lambda r: r["timestamp"])
        if not args.include_future:
            now_hour = datetime.now().replace(minute=0, second=0, microsecond=0)
            records = [record for record in records if parse_hour_timestamp(record["timestamp"]) <= now_hour]
        payload = build_payload(station, records, args.start_year, args.end_year, args.end_month)
        save_json(station.output, payload)
        print(f"saved {station.output} ({len(records)} records)")


if __name__ == "__main__":
    main()
