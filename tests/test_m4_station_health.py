"""M4-1：设备状态监测工具与空值/缺测负例。"""
from __future__ import annotations

import json
import unittest

from fieldstation.agents.tools.station_tools import station_health_tool


def _reading(station="BADG", sensor="power", metric="voltage", value=12.0,
             at="2026-10-18T10:00:00+00:00", flag=""):
    return {
        "station_id": station,
        "sensor": sensor,
        "metric": metric,
        "value": value,
        "unit": "V",
        "observed_at": at,
        "quality_flag": flag,
    }


class TestStationHealthTool(unittest.TestCase):
    def test_summarizes_station_health(self):
        tool = station_health_tool()
        result = tool.invoke({"readings": [
            _reading(value=12.0, at="2026-10-18T10:00:00+00:00"),
            _reading(value=11.8, at="2026-10-18T10:05:00+00:00"),
            _reading(sensor="link", metric="rssi", value=-90.0),
        ]})
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["summary"]["total"], 3)
        self.assertEqual(result.data["summary"]["missing"], 0)
        station = result.data["stations"][0]
        self.assertEqual(station["station_id"], "BADG")
        self.assertEqual(station["health_score"], 1.0)
        self.assertEqual(station["status"], "ok")
        self.assertEqual(station["latest_observed_at"], "2026-10-18T10:05:00+00:00")

    def test_empty_input_is_safe(self):
        result = station_health_tool().invoke({"readings": []})
        self.assertTrue(result.ok)
        self.assertEqual(result.data["stations"], [])
        self.assertEqual(result.data["summary"]["total"], 0)

    def test_null_value_counts_as_missing_and_degrades_health(self):
        result = station_health_tool().invoke({"readings": [
            _reading(value=12.0),
            _reading(value=None, flag="missing"),
        ]})
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["summary"]["missing"], 1)
        station = result.data["stations"][0]
        self.assertEqual(station["health_score"], 0.5)
        self.assertEqual(station["status"], "critical")
        self.assertEqual(station["metrics"][0]["missing"], 1)

    def test_bad_row_is_clear_error(self):
        result = station_health_tool().invoke({"readings": [
            {"station_id": "BADG", "sensor": "power", "metric": "voltage"},
        ]})
        self.assertFalse(result.ok)
        self.assertIn("readings[0]", result.error or "")

    def test_result_is_json_serializable(self):
        result = station_health_tool().invoke({"readings": [_reading()]})
        json.dumps(result.data, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
