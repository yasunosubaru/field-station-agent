"""M5-3：运行看板的生成与口径（issue #62）。

覆盖：

* 三类视图能从已提交的 M5-1 全链日志生成，关键数值与口径钉死；
* 阶段归属：只认 `device_monitor` 的 `station_health` 与 `qc` 的 `slip_detect`，
  其他阶段的同名结果不参与；卫星组匹配不上时失败而不是猜；
* 输出确定（同一份日志两次生成逐字节相同）且钉 LF；
* 入库的页面与摘要与当前生成器一致 —— 改口径必须重新生成并提交；
* 输入错误的退出码分层（2 = 用法/日志不可读或非 UTF-8，1 = 日志缺三类视图所需数据）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "make_station_dashboard.py"
COMMITTED_LOG = ROOT / "logs" / "m5_pipeline_replay.json"
COMMITTED_PAGE = ROOT / "figures" / "m5_dashboard.html"
COMMITTED_SUMMARY = ROOT / "logs" / "m5_dashboard.json"
LOG_SHA = "04fa5d7ce63405cd4aab478ae90ef79433229529680195dfbc30ffd87a335ded"


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=120)


class TestDashboard(unittest.TestCase):
    def _generate(self, td: Path, log: Path = COMMITTED_LOG):
        page = td / "page.html"
        summary = td / "summary.json"
        run = _run("--log", str(log), "--page", str(page), "--summary", str(summary))
        return run, page, summary

    def test_three_views_from_committed_log(self):
        with tempfile.TemporaryDirectory() as td:
            run, page, summary = self._generate(Path(td))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            data = json.loads(summary.read_text(encoding="utf-8"))
            self.assertEqual(data["kind"], "fieldstation.m5_dashboard.summary")
            self.assertEqual(data["source"]["log"], "logs/m5_pipeline_replay.json")
            self.assertEqual(data["source"]["log_sha256"], LOG_SHA)
            self.assertEqual(data["chain"]["checks"], "10/10")
            self.assertEqual(data["counts"], {
                "stations": 1, "alerts": 2,
                "alerts_by_level": {"warn": 2}, "orders": 1})

            station = data["stations"][0]
            self.assertEqual(
                (station["station_id"], station["health_score"], station["status"],
                 station["missing"], station["total"]),
                ("BADG", 0.667, "degraded", 1, 3))

            titles = {(alert["source"], alert["title"]) for alert in data["alerts"]}
            self.assertIn(("data_quality", "GPS 01 检出周跳 / 相位阶跃"), titles)
            self.assertIn(("station_health", "BADG 台站状态 degraded"), titles)
            self.assertEqual(data["alerts"][0]["evidence"],
                             [{"agent": "qc", "call_id": "t0001"}])
            self.assertEqual(data["alerts"][1]["evidence"],
                             [{"agent": "device_monitor", "call_id": "t0001"}])

            order = data["orders"][0]
            self.assertEqual(
                (order["order_id"], order["priority"], order["status"],
                 order["action"]),
                ("WO-0001", "P0", "open", "restart_receiver"))
            self.assertEqual(order["execution"]["status"], "accepted")
            self.assertEqual(order["execution"]["execution_mode"], "simulated")

            page_text = page.read_text(encoding="utf-8")
            for needle in ("台站健康度", "告警", "工单", "BADG", "0.667",
                           "GPS 01", "WO-0001", "合成样本"):
                self.assertIn(needle, page_text)
            # 公开页面不能带本机绝对路径
            self.assertNotIn(str(ROOT), page_text)

    def test_outputs_deterministic_and_lf(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            first = self._generate(td / "a")
            second = self._generate(td / "b")
            for run, _, _ in (first, second):
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first[1].read_bytes(), second[1].read_bytes())
            self.assertEqual(first[2].read_bytes(), second[2].read_bytes())
            for path in (first[1], first[2]):
                raw = path.read_bytes()
                self.assertNotIn(b"\r\n", raw)
                self.assertTrue(raw.endswith(b"\n"))

    def test_committed_outputs_match_regeneration(self):
        """入库页面/摘要必须等于当前生成器的输出：改口径后要重新生成并提交。"""
        with tempfile.TemporaryDirectory() as td:
            run, page, summary = self._generate(Path(td))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(
                page.read_bytes(), COMMITTED_PAGE.read_bytes(),
                "figures/m5_dashboard.html 与生成器不一致：重新运行 "
                "python tools/make_station_dashboard.py 并提交")
            self.assertEqual(
                summary.read_bytes(), COMMITTED_SUMMARY.read_bytes(),
                "logs/m5_dashboard.json 与生成器不一致：重新运行 "
                "python tools/make_station_dashboard.py 并提交")

    def test_missing_or_bad_log_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            run, _, _ = self._generate(td, log=td / "nope.json")
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn("[阻断]", run.stdout)

            bad = td / "bad.json"
            bad.write_text("{}", encoding="utf-8")
            run, _, _ = self._generate(td, log=bad)
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn("不是 M5 全链回放日志", run.stdout)

    def test_log_without_required_data_exits_1(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)

            # 缺 device_monitor 的 station_health → 台站健康度视图无法生成
            log = json.loads(COMMITTED_LOG.read_text(encoding="utf-8"))
            log["trace"] = [event for event in log["trace"]
                            if not (event.get("kind") == "tool_result"
                                    and event.get("tool") == "station_health")]
            stripped = td / "no-health.json"
            stripped.write_text(json.dumps(log, ensure_ascii=False), encoding="utf-8")
            run, _, _ = self._generate(td, log=stripped)
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("station_health", run.stdout)

            # 缺 create_work_order → 工单视图无法生成
            log = json.loads(COMMITTED_LOG.read_text(encoding="utf-8"))
            for stage in log["stages"]:
                if stage.get("stage") == "operations_dispatch":
                    stage["artifacts"] = {}
            stripped = td / "no-order.json"
            stripped.write_text(json.dumps(log, ensure_ascii=False), encoding="utf-8")
            run, _, _ = self._generate(td, log=stripped)
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("create_work_order", run.stdout)

    def test_other_stage_station_health_ignored(self):
        """别的阶段（如 fault_diagnosis）也调了 station_health：不得改变台站视图。"""
        log = json.loads(COMMITTED_LOG.read_text(encoding="utf-8"))
        log["trace"].append({
            "kind": "tool_call", "agent": "fault_diagnosis", "call_id": "t0099",
            "tool": "station_health", "args": {}, "approved": True})
        log["trace"].append({
            "kind": "tool_result", "agent": "fault_diagnosis", "call_id": "t0099",
            "tool": "station_health", "ok": True, "error": None,
            "result": {"stations": [{"station_id": "FAKE", "health_score": 1.0,
                                     "status": "ok", "missing": 0, "total": 1,
                                     "metrics": [], "quality_flags": []}],
                       "summary": {"total": 1, "missing": 0, "alerts": []}}})
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fake_log = td / "fake-health.json"
            fake_log.write_text(json.dumps(log, ensure_ascii=False), encoding="utf-8")
            run, _, summary = self._generate(td, log=fake_log)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            data = json.loads(summary.read_text(encoding="utf-8"))
            self.assertEqual([s["station_id"] for s in data["stations"]], ["BADG"])

    def test_unmatched_slip_group_exits_1_instead_of_guessing(self):
        log = json.loads(COMMITTED_LOG.read_text(encoding="utf-8"))
        for event in log["trace"]:
            if (event.get("kind") == "tool_call" and event.get("agent") == "qc"
                    and event.get("tool") == "slip_detect"):
                event["args"]["series"][0]["gps_tow_s"] += 1  # 破坏与输入组的匹配
                break
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            bad = td / "bad-slip.json"
            bad.write_text(json.dumps(log, ensure_ascii=False), encoding="utf-8")
            run, _, _ = self._generate(td, log=bad)
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("无法归属卫星组", run.stdout)

    def test_non_utf8_log_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            bad = td / "bad-utf8.json"
            bad.write_bytes(b"\xff\xfe\x00A")
            run, _, _ = self._generate(td, log=bad)
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn("[阻断]", run.stdout)


if __name__ == "__main__":
    unittest.main()
