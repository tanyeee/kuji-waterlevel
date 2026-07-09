from __future__ import annotations

import json
import argparse
from datetime import datetime, timedelta
from pathlib import Path


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"meta": {}, "records": []}


def save(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def merge_pair(historical_path: Path, recent_path: Path) -> None:
    historical = load(historical_path)
    recent = load(recent_path)

    if not recent.get("records"):
        print(f"{recent_path}: recent data is empty; nothing to merge")
        return

    cutoff = datetime.now() - timedelta(days=14)
    hist_map = {r["timestamp"]: r for r in historical.get("records", [])}
    keep_recent = []
    merged_count = 0
    for rec in recent.get("records", []):
        ts = datetime.fromisoformat(rec["timestamp"])
        if ts < cutoff:
            hist_map[rec["timestamp"]] = rec
            merged_count += 1
        else:
            keep_recent.append(rec)

    historical["records"] = sorted(hist_map.values(), key=lambda r: r["timestamp"])
    historical.setdefault("meta", {})["dataset_end"] = historical["records"][-1]["timestamp"]
    historical["meta"]["record_count"] = len(historical["records"])
    recent["records"] = keep_recent
    recent.setdefault("meta", {})["record_count"] = len(keep_recent)

    save(historical_path, historical)
    save(recent_path, recent)
    print(f"{recent_path}: merged {merged_count} records into historical; kept {len(keep_recent)} recent records")


def station_pairs_from_config(config_path: Path) -> list[tuple[Path, Path]]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    pairs: list[tuple[Path, Path]] = []
    for station in config.get("stations", []):
        data_dir = station.get("data_dir")
        if not data_dir:
            continue
        base = Path(data_dir)
        pairs.append((base / "historical_hourly.json", base / "recent_hourly.json"))
    return pairs


def main() -> None:
    parser = argparse.ArgumentParser(description="recent_hourly.json の古いデータを historical_hourly.json へ移します。")
    parser.add_argument("--config", default="config/stations.json")
    parser.add_argument("--historical", default=None)
    parser.add_argument("--recent", default=None)
    args = parser.parse_args()

    if args.historical or args.recent:
        if not args.historical or not args.recent:
            raise SystemExit("--historical and --recent must be provided together")
        pairs = [(Path(args.historical), Path(args.recent))]
    elif Path(args.config).exists():
        pairs = station_pairs_from_config(Path(args.config))
    else:
        pairs = [(Path("data/historical_hourly.json"), Path("data/recent_hourly.json"))]

    if not pairs:
        raise SystemExit("no station data pairs configured")

    for historical_path, recent_path in pairs:
        merge_pair(historical_path, recent_path)


if __name__ == "__main__":
    main()
