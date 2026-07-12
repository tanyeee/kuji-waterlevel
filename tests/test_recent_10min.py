import json
import tempfile
import unittest
from pathlib import Path

from scripts import update_recent_10min_from_kawabou as recent_10min


def record(timestamp: str, value: float) -> dict:
    return {"timestamp": timestamp, "value": value, "flag": "", "resolution": "10min"}


class RecentTenMinuteTests(unittest.TestCase):
    def test_merge_prefers_latest_fetch_and_sorts(self):
        existing = [record("2026-07-10T00:00", 1.0), record("2026-07-10T00:10", 1.1)]
        fetched = [record("2026-07-10T00:10", 2.1), record("2026-07-10T00:20", 2.2)]

        merged = recent_10min.merge_observations(existing, fetched)

        self.assertEqual([item["timestamp"] for item in merged], [
            "2026-07-10T00:00", "2026-07-10T00:10", "2026-07-10T00:20"
        ])
        self.assertEqual(merged[1]["value"], 2.1)

    def test_clip_keeps_a_7_day_window_inclusively(self):
        records = [
            record("2026-07-05T23:50", 0.9),
            record("2026-07-06T00:00", 1.0),
            record("2026-07-13T00:00", 1.2),
        ]

        clipped = recent_10min.clip_recent(records, 168)

        self.assertEqual([item["timestamp"] for item in clipped], [
            "2026-07-06T00:00", "2026-07-13T00:00"
        ])

    def test_load_existing_records_tolerates_invalid_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recent.json"
            self.assertEqual(recent_10min.load_existing_records(path), [])
            path.write_text("not json", encoding="utf-8")
            self.assertEqual(recent_10min.load_existing_records(path), [])
            path.write_text(json.dumps({"records": [record("2026-07-10T00:00", 1.0)]}), encoding="utf-8")
            self.assertEqual(len(recent_10min.load_existing_records(path)), 1)


if __name__ == "__main__":
    unittest.main()
