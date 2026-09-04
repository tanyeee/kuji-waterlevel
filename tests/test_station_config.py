import json
import unittest
from pathlib import Path

from scripts import update_recent_10min_from_kawabou as ten_min
from scripts import update_recent_from_monthly_page as hourly


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config/stations.json"
TRIBUTARIES = {
    "kihatsu": ("303011283322080", "機初", "里川"),
    "tsuneibashi": ("303011283322070", "常井橋", "山田川"),
}
DISPLAY_GROUPS = {
    "久慈川": ["tomioka-bashi", "nukada"],
    "里川": ["kihatsu"],
    "山田川": ["tsuneibashi"],
    "那珂川": ["nakagawa-ohashi"],
}


class StationConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(CONFIG.read_text(encoding="utf-8"))
        cls.stations = {s["id"]: s for s in cls.config["stations"]}

    def test_river_membership_is_complete_and_unique(self):
        self.assertEqual(len(self.stations), len(self.config["stations"]))
        membership = []
        for river in self.config["rivers"]:
            for station_id in river["station_ids"]:
                self.assertEqual(self.stations[station_id]["river_id"], river["id"])
                membership.append(station_id)
        self.assertCountEqual(membership, self.stations)
        self.assertIn(self.config["default_station"], self.stations)

    def test_tributaries_are_selected_by_both_updaters(self):
        hourly_targets = {s.id: s for s in hourly.load_config_targets(CONFIG)}
        ten_min_targets = {s.id: s for s in ten_min.load_config_targets(CONFIG)}
        for station_id, (code, name, river) in TRIBUTARIES.items():
            with self.subTest(station=station_id):
                station = self.stations[station_id]
                self.assertEqual(station["river_id"], "kuji")
                self.assertEqual(station["observation_name"], name)
                self.assertIn(river, station["name"])
                self.assertEqual(hourly_targets[station_id].station_id, code)
                self.assertEqual(ten_min_targets[station_id].hydrology_station_id, code)

    def test_display_groups_hide_tidal_stations_without_stopping_updates(self):
        groups = {group["label"]: group["station_ids"] for group in self.config["display_groups"]}
        self.assertEqual(groups, DISPLAY_GROUPS)
        displayed = {station_id for ids in groups.values() for station_id in ids}
        hidden = set(self.stations) - displayed
        self.assertEqual(hidden, {
            "sakakibashi", "kuji-ohashi", "hinuma-bashi", "minato-ohashi",
            "suifu-bashi", "kunita-ohashi",
        })
        hourly_targets = {station.id for station in hourly.load_config_targets(CONFIG)}
        ten_min_targets = {station.id for station in ten_min.load_config_targets(CONFIG)}
        self.assertTrue(hidden <= hourly_targets)
        self.assertTrue(hidden <= ten_min_targets)

    def test_tributary_datasets_match_the_station_and_include_2016(self):
        for station_id, (code, name, river) in TRIBUTARIES.items():
            directory = ROOT / self.stations[station_id]["data_dir"]
            for filename in ("historical_hourly.json", "recent_hourly.json", "recent_10min.json"):
                with self.subTest(station=station_id, file=filename):
                    payload = json.loads((directory / filename).read_text(encoding="utf-8"))
                    meta, records = payload["meta"], payload["records"]
                    self.assertEqual(meta.get("station_code", meta.get("station_id")), code)
                    self.assertTrue(records)
                    timestamps = [r["timestamp"] for r in records]
                    self.assertEqual(timestamps, sorted(set(timestamps)))
                    self.assertTrue(any(r["value"] is not None for r in records))
                    if filename == "historical_hourly.json":
                        self.assertTrue(any(r["timestamp"].startswith("2016-") and r["value"] is not None for r in records))
                    elif filename == "recent_10min.json":
                        self.assertEqual(meta["station_name"], name)
                        self.assertEqual(meta["river_name"], river)
                        self.assertTrue(all(r["resolution"] == "10min" for r in records))


if __name__ == "__main__":
    unittest.main()
