import json
import tempfile
import unittest
from pathlib import Path

from scripts import update_recent_10min_from_kawabou as recent_10min
from scripts import update_recent_from_kawabou_files as kawabou_files


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

    def test_kawabou_observation_code_is_zero_padded(self):
        self.assertEqual(kawabou_files.build_obs_fcd(2049, 4, 1), "0204900400001")
        self.assertEqual(kawabou_files.build_obs_fcd(21271, 4, 23), "2127100400023")

    def test_kawabou_values_are_converted_and_invalid_codes_are_missing(self):
        values = [
            {"obsTime": "2026/09/10 20:10", "stg": 2.05, "stgCcd": 0},
            {"obsTime": "2026/09/10 20:20", "stg": 0, "stgCcd": 140},
        ]
        records = kawabou_files.convert_records(values, "10min")
        self.assertEqual(records[0], {
            "timestamp": "2026-09-10T20:10", "value": 2.05, "flag": "", "resolution": "10min"
        })
        self.assertIsNone(records[1]["value"])
        self.assertEqual(records[1]["flag"], "ccd:140")


if __name__ == "__main__":
    unittest.main()
