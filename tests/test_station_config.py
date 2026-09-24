import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config/stations.json"
DISPLAY_GROUPS = {
    "久慈川": ["tomioka-bashi", "nukada", "sakakibashi-ue"],
    "里川": ["kihatsu"],
    "山田川": ["tsuneibashi"],
    "涸沼川": ["takahashi", "shimoishizaki"],
    "那珂川": ["nakagawa-ohashi"],
}
FLOOD_LEVELS = {
    "tomioka-bashi": (2.5, 2.9, 3.5, 4.6),
    "kihatsu": (3.0, 3.0, 3.1, 3.8),
    "tsuneibashi": (3.0, 3.5, 3.8, 4.3),
    "nakagawa-ohashi": (3.5, 4.1, 4.5, 5.8),
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

    def test_display_groups_hide_tidal_stations(self):
        groups = {group["label"]: group["station_ids"] for group in self.config["display_groups"]}
        self.assertEqual(groups, DISPLAY_GROUPS)
        displayed = {station_id for ids in groups.values() for station_id in ids}
        hidden = set(self.stations) - displayed
        self.assertEqual(hidden, {
            "sakakibashi", "kuji-ohashi", "hinuma-bashi", "minato-ohashi",
            "suifu-bashi", "kunita-ohashi",
        })

    def test_official_flood_levels_are_attached_to_reference_stations(self):
        for station_id, expected in FLOOD_LEVELS.items():
            levels = self.stations[station_id]["flood_levels"]
            actual = (
                levels["flood_caution"],
                levels["evacuation_judgment"],
                levels["flood_danger"],
                levels["flood_occurrence"],
            )
            self.assertEqual(actual, expected)
        nukada = self.stations["nukada"]
        self.assertEqual(
            (
                nukada["flood_levels"]["flood_caution"],
                nukada["flood_levels"]["evacuation_judgment"],
                nukada["flood_levels"]["flood_danger"],
                nukada["flood_levels"]["flood_occurrence"],
            ),
            (4.8, 5.3, 5.9, 7.1),
        )
        self.assertEqual(nukada["flood_levels_basis"]["type"], "estimated")
        self.assertEqual(nukada["flood_levels_basis"]["source_station_id"], "tomioka-bashi")

    def test_only_shimoishizaki_has_the_revetment_inundation_zone(self):
        stations_with_zones = {
            station_id: station["level_zones"]
            for station_id, station in self.stations.items()
            if station.get("level_zones")
        }
        self.assertEqual(set(stations_with_zones), {"shimoishizaki"})
        zone = stations_with_zones["shimoishizaki"][0]
        self.assertEqual(zone["from"], 1.9)
        self.assertEqual(zone["label"], "護岸浸水目安")
        self.assertIn("防災基準水位ではありません", zone["note"])


if __name__ == "__main__":
    unittest.main()
