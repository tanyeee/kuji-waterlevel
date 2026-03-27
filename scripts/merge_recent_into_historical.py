from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"meta": {}, "records": []}


def save(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    historical_path = Path("data/historical_hourly.json")
    recent_path = Path("data/recent_hourly.json")
    historical = load(historical_path)
    recent = load(recent_path)

    if not recent.get("records"):
        print("recent data is empty; nothing to merge")
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
    print(f"merged {merged_count} records into historical; kept {len(keep_recent)} recent records")


if __name__ == "__main__":
    main()
