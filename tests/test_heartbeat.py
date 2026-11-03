"""M6-5：设备心跳与离线判定（issue #109）。

钉住四件事：

* 三态判据：fresh → ``online``、几个周期没来 → ``stale``、更久 → ``offline``；
* **字段缺失 → ``unknown``，不误判 offline**（不知道不等于掉线）；
* 心跳与读数健康度**正交**：离线 + 无读数是 ``offline``，在线 + 读数异常是
  ``degraded``，两者不合并成一个分数；
* 回放日志确定（两次逐字节相同）且看板能把心跳单列一块面板。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPLAY = ROOT / "harness" / "heartbeat_replay.py"
DASHBOARD = ROOT / "tools" / "make_station_dashboard.py"
COMMITTED_LOG = ROOT / "logs" / "m5_pipeline_replay.json"
HEARTBEAT_LOG = ROOT / "logs" / "heartbeat_replay.json"

for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.agents.tools.heartbeat_tools import (  # noqa: E402
    DeviceHeartbeatTool,
    classify,
    load_policy,
)
from fieldstation.agents.tools.station_tools import station_health_tool  # noqa: E402

NOW = "2024-01-01T06:00:00+00:00"
POLICY = {"stale_after_intervals": 2.0, "offline_after_intervals": 6.0}


def _run(tool: Path, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(tool), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=120)


class TestClassify(unittest.TestCase):
    def _classify(self, seen: str, interval: float = 300.0):
        now = datetime.fromisoformat(NOW)
        return classify(last_seen_at=seen, interval_s=interval, now=now,
                        policy=POLICY)

    def test_three_states(self):
        status, age, _ = self._classify("2024-01-01T05:59:00+00:00")
        self.assertEqual(status, "online")
        self.assertAlmostEqual(age, 60.0)

        status, age, _ = self._classify("2024-01-01T05:40:00+00:00")  # 4 周期
        self.assertEqual(status, "stale")

        status, age, _ = self._classify("2024-01-01T05:20:00+00:00")  # 8 周期
        self.assertEqual(status, "offline")

    def test_boundaries_are_inclusive(self):
        # exactly stale threshold (2 × 300s) 仍是 online；超过才 stale
        self.assertEqual(self._classify("2024-01-01T05:50:00+00:00")[0], "online")
        # exactly offline threshold (6 × 300s) 仍是 stale；超过才 offline
        self.assertEqual(self._classify("2024-01-01T05:30:00+00:00")[0], "stale")

    def test_missing_fields_are_unknown_not_offline(self):
        for seen, interval in ((None, 300.0), ("", 300.0), ("not-a-time", 300.0),
                               ("2024-01-01T05:00:00+00:00", None),
                               ("2024-01-01T05:00:00+00:00", 0)):
            status, _, reason = self._classify(seen, interval)
            self.assertEqual(status, "unknown", (seen, interval, reason))

    def test_future_last_seen_is_online_with_reason(self):
        status, age, reason = self._classify("2024-01-01T06:01:00+00:00")
        self.assertEqual(status, "online")
        self.assertLess(age, 0)
        self.assertIn("时钟偏差", reason)

    def test_policy_comes_from_config(self):
        policy = load_policy()
        self.assertEqual(policy["source"], "config")
        self.assertLess(policy["stale_after_intervals"],
                        policy["offline_after_intervals"])


class TestTool(unittest.TestCase):
    def _invoke(self, heartbeats, **kwargs):
        return DeviceHeartbeatTool(**kwargs).invoke(
            {"heartbeats": heartbeats, "now": NOW})

    def test_statuses_and_alerts(self):
        result = self._invoke([
            {"device_id": "A", "station_id": "BADG",
             "last_seen_at": "2024-01-01T05:59:00+00:00", "interval_s": 300},
            {"device_id": "B", "station_id": "BADG",
             "last_seen_at": "2024-01-01T05:40:00+00:00", "interval_s": 300},
            {"device_id": "C", "station_id": "BADG",
             "last_seen_at": "2024-01-01T05:00:00+00:00", "interval_s": 300},
            {"device_id": "D", "station_id": "BADG", "interval_s": 300},
        ])
        self.assertTrue(result.ok, result.error)
        by_id = {row["device_id"]: row for row in result.data["devices"]}
        self.assertEqual(by_id["A"]["status"], "online")
        self.assertEqual(by_id["B"]["status"], "stale")
        self.assertEqual(by_id["C"]["status"], "offline")
        self.assertEqual(by_id["D"]["status"], "unknown")
        # unknown 不进告警：不知道不等于出事。
        self.assertEqual(result.data["summary"]["alerts"], ["C", "B"])
        levels = {alert["device_id"]: alert["level"]
                  for alert in result.data["alerts"]}
        self.assertEqual(levels, {"B": "warn", "C": "critical"})
        self.assertEqual(result.data["policy"], POLICY)

    def test_bad_args_return_errors(self):
        tool = DeviceHeartbeatTool()
        self.assertFalse(tool.invoke({"heartbeats": "x", "now": NOW}).ok)
        self.assertFalse(tool.invoke({"heartbeats": []}).ok)          # 缺 now
        self.assertFalse(tool.invoke(
            {"heartbeats": [{"device_id": ""}], "now": NOW}).ok)
        self.assertFalse(tool.invoke(
            {"heartbeats": ["x"], "now": NOW}).ok)

    def test_reading_health_and_heartbeat_are_orthogonal(self):
        """离线 + 无读数 = offline；在线 + 读数异常 = degraded。"""
        heartbeat = self._invoke([
            {"device_id": "GNSS-RX", "station_id": "BADG",
             "last_seen_at": "2024-01-01T04:00:00+00:00", "interval_s": 300}])
        self.assertEqual(heartbeat.data["devices"][0]["status"], "offline")

        empty = station_health_tool().invoke({"readings": []})
        self.assertTrue(empty.ok)
        self.assertEqual(empty.data["stations"], [])          # 不把离线写成读数状态

        degraded = station_health_tool().invoke({"readings": [
            {"station_id": "BADG", "sensor": "power", "metric": "voltage",
             "value": None, "unit": "V", "observed_at": NOW},
            {"station_id": "BADG", "sensor": "power", "metric": "current",
             "value": 1.0, "unit": "A", "observed_at": NOW},
            {"station_id": "BADG", "sensor": "link", "metric": "rssi",
             "value": -88.0, "unit": "dBm", "observed_at": NOW},
        ]})
        self.assertEqual(degraded.data["stations"][0]["status"], "degraded")

        online = self._invoke([
            {"device_id": "GNSS-RX", "station_id": "BADG",
             "last_seen_at": "2024-01-01T05:59:00+00:00", "interval_s": 300}])
        self.assertEqual(online.data["devices"][0]["status"], "online")
        # 两条判据各自成立，没有被合并成一个「健康分」。
        self.assertNotIn("health_score", heartbeat.data["devices"][0])


class TestHeartbeatReplay(unittest.TestCase):
    def test_replay_is_deterministic_and_lf(self):
        with tempfile.TemporaryDirectory() as td:
            first = Path(td) / "a.json"
            second = Path(td) / "b.json"
            for path in (first, second):
                run = _run(REPLAY, "--out", str(path))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            raw = first.read_bytes()
            self.assertNotIn(b"\r\n", raw)
            self.assertTrue(raw.endswith(b"\n"))

    def test_committed_replay_matches_generator(self):
        self.assertTrue(HEARTBEAT_LOG.is_file(),
                        "先运行 python harness/heartbeat_replay.py")
        committed = json.loads(HEARTBEAT_LOG.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as td:
            fresh = Path(td) / "hb.json"
            self.assertEqual(_run(REPLAY, "--out", str(fresh)).returncode, 0)
            self.assertEqual(
                committed, json.loads(fresh.read_text(encoding="utf-8")),
                "logs/heartbeat_replay.json 与生成器不一致：重新运行并提交")

    def test_dashboard_shows_heartbeat_panel(self):
        self.assertTrue(HEARTBEAT_LOG.is_file())
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            page = td / "hb.html"
            summary = td / "hb-summary.json"
            run = _run(DASHBOARD, "--log", str(COMMITTED_LOG),
                       "--heartbeat", str(HEARTBEAT_LOG),
                       "--page", str(page), "--summary", str(summary))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            page_text = page.read_text(encoding="utf-8")
            self.assertIn("设备心跳", page_text)
            self.assertIn("heartbeat", page_text)
            data = json.loads(summary.read_text(encoding="utf-8"))
            self.assertEqual(data["counts"]["heartbeats"], 4)
            titles = {(a["source"], a["title"]) for a in data["alerts"]}
            self.assertIn(("heartbeat", "POWER 心跳 stale"), titles)
            self.assertIn(("heartbeat", "LINK 心跳 offline"), titles)


if __name__ == "__main__":
    unittest.main()
