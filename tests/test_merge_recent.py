import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from scripts import merge_recent_into_historical as merger


class MergeRecentTests(unittest.TestCase):
    def test_new_station_with_only_recent_records_keeps_empty_history(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            historical_path = Path(temp_dir) / "historical_hourly.json"
            recent_path = Path(temp_dir) / "recent_hourly.json"
            recent_path.write_text(json.dumps({
                "meta": {},
                "records": [{"timestamp": "2026-09-10T20:00", "value": 1.23, "flag": ""}],
            }), encoding="utf-8")

            with patch.object(merger, "datetime") as mocked_datetime:
                mocked_datetime.now.return_value = datetime(2026, 9, 10, 21, 0)
                mocked_datetime.fromisoformat.side_effect = datetime.fromisoformat
                merger.merge_pair(historical_path, recent_path)

            historical = json.loads(historical_path.read_text(encoding="utf-8"))
            recent = json.loads(recent_path.read_text(encoding="utf-8"))
            self.assertEqual(historical["records"], [])
            self.assertEqual(historical["meta"]["record_count"], 0)
            self.assertEqual(len(recent["records"]), 1)
            self.assertEqual(recent["meta"]["dataset_start"], "2026-09-10T20:00")
            self.assertEqual(recent["meta"]["dataset_end"], "2026-09-10T20:00")


if __name__ == "__main__":
    unittest.main()
