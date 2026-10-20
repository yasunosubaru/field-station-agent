"""设备侧合成读数（X-1 第 5 项）：供电 / 网络 / 安防异常。

合成器只造**读数 + 质量标记**；健康度仍由 `station_health` 统一计算 ——
测试同时钉住「异常场景确实会被现有判据抓到」，不另立阈值。
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone

from fieldstation import synthetic
from fieldstation.agents.tools.station_tools import station_health_tool
from fieldstation.store.model import to_dict

AT = datetime(2026, 10, 19, 8, 10, tzinfo=timezone.utc)


def _health(readings) -> dict:
    result = station_health_tool().invoke(
        {"readings": [to_dict(reading) for reading in readings]})
    assert result.ok, result.error
    return result.data


class TestDeviceReadings(unittest.TestCase):
    def test_baseline_is_ok(self):
        readings = synthetic.device_readings(station="BADG", observed_at=AT)
        self.assertEqual(
            [(r.sensor, r.metric) for r in readings],
            [("power", "voltage"), ("link", "rssi"), ("uplink", "packets_5min")])
        self.assertTrue(all(r.quality_flag == "" for r in readings))
        data = _health(readings)
        self.assertEqual(data["stations"][0]["status"], "ok")
        self.assertEqual(data["summary"]["missing"], 0)

    def test_power_undervoltage_is_degraded(self):
        readings = synthetic.device_readings(
            station="BADG", observed_at=AT,
            anomalies=["power_undervoltage"])
        self.assertEqual(readings[0].value, 10.2)
        self.assertEqual(readings[0].quality_flag, "undervoltage")
        station = _health(readings)["stations"][0]
        self.assertEqual(station["status"], "degraded")
        self.assertIn("undervoltage", station["quality_flags"])

    def test_link_loss_is_critical(self):
        readings = synthetic.device_readings(
            station="BADG", observed_at=AT, anomalies=["link_loss"])
        self.assertIsNone(readings[1].value)
        self.assertIsNone(readings[2].value)
        data = _health(readings)
        self.assertEqual(data["stations"][0]["status"], "critical")
        self.assertEqual(data["summary"]["missing"], 2)

    def test_security_intrusion_adds_door_flag(self):
        readings = synthetic.device_readings(
            station="BADG", observed_at=AT, anomalies=["security_intrusion"])
        self.assertEqual(len(readings), 4)
        door = readings[-1]
        self.assertEqual(
            (door.sensor, door.metric, door.value, door.quality_flag),
            ("security", "door", 1.0, "door_open"))
        self.assertEqual(_health(readings)["stations"][0]["status"], "degraded")

    def test_combined_anomalies(self):
        readings = synthetic.device_readings(
            station="BADG", observed_at=AT,
            anomalies=("link_loss", "security_intrusion"))
        self.assertEqual(len(readings), 4)
        data = _health(readings)
        self.assertEqual(data["summary"]["missing"], 2)
        self.assertEqual(data["stations"][0]["status"], "critical")

    def test_seeded_jitter_is_reproducible(self):
        first = synthetic.device_readings(station="BADG", observed_at=AT, seed=7)
        second = synthetic.device_readings(station="BADG", observed_at=AT, seed=7)
        other = synthetic.device_readings(station="BADG", observed_at=AT, seed=8)
        self.assertEqual([to_dict(r) for r in first],
                         [to_dict(r) for r in second])
        self.assertNotEqual([to_dict(r) for r in first],
                            [to_dict(r) for r in other])

    def test_unknown_anomaly_or_bad_arguments_rejected(self):
        with self.assertRaises(ValueError):
            synthetic.device_readings(station="BADG", observed_at=AT,
                                      anomalies=["meteor"])
        with self.assertRaises(ValueError):
            synthetic.device_readings(station="", observed_at=AT)
        with self.assertRaises(ValueError):
            synthetic.device_readings(station="BADG",
                                      observed_at="2026-10-19")


if __name__ == "__main__":
    unittest.main()
