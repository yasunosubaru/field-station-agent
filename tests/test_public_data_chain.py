"""公开数据链路（#98）：公开设备读数接进五阶段链，看板渲染真实数值。

钉住：

* 链路：5 阶段 / 7 消息 / 8 项机械核对全过；结论里的数字来自工具返回；
* 数据源标注：设备侧 public（含许可/署名/样本路径），观测侧 synthetic（含原因）；
* 确定性：两次运行逐字节相同，与入库记录一致；
* 看板：用这条链路的日志渲染出的页面/摘要与入库版本一致，且页面标了数据来源与许可。
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
CHAIN = ROOT / "harness" / "public_data_chain.py"
DASHBOARD = ROOT / "tools" / "make_station_dashboard.py"
COMMITTED_LOG = ROOT / "logs" / "public_data_chain_202401d01.json"
COMMITTED_PAGE = ROOT / "figures" / "m5_public_chain_dashboard.html"
COMMITTED_SUMMARY = ROOT / "logs" / "public_chain_dashboard.json"


def _run(script: Path, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=300)


class TestPublicDataChain(unittest.TestCase):
    def test_chain_checks_and_conclusions(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "chain.json"
            run = _run(CHAIN, "--out", str(out))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            log = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(log["summary"]["checks"], "8/8")
            self.assertEqual(log["summary"]["stages"], 5)
            self.assertEqual(log["summary"]["messages"], 7)
            self.assertEqual([m["msg_id"] for m in log["messages"]],
                             [f"m{i:04d}" for i in range(1, 8)])
            stages = {s["stage"]: s for s in log["stages"]}
            device = stages["device_monitor"]["conclusion"]["attribution"]
            self.assertEqual(device["fault_type"], "device_quality_flag")
            self.assertIn("low_temp", device["evidence"][0]["finding"])
            qc = stages["qc"]["conclusion"]["attribution"]
            self.assertEqual(qc["fault_type"], "phase_slip_detected")
            self.assertIn("union': 1", qc["evidence"][0]["finding"])
            order = stages["operations_dispatch"]["artifacts"]["work_order"]
            self.assertEqual(order["order_id"], "WO-0001")

    def test_sources_are_labelled(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "chain.json"
            run = _run(CHAIN, "--out", str(out))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            log = json.loads(out.read_text(encoding="utf-8"))
            device = log["data_sources"]["device"]
            self.assertEqual(device["kind"], "public")
            self.assertEqual(device["license"], "CC BY 4.0")
            self.assertEqual(device["n_readings"], 96)
            self.assertGreater(device["n_low_temp_flagged"], 0)
            observations = log["data_sources"]["observations"]
            self.assertEqual(observations["kind"], "synthetic")
            self.assertIn("CRINEX", observations["reason"])

    def test_deterministic_and_matches_committed(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            first, second = td / "a.json", td / "b.json"
            for out in (first, second):
                run = _run(CHAIN, "--out", str(out))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertNotIn(b"\r\n", first.read_bytes())
            self.assertEqual(first.read_bytes(), COMMITTED_LOG.read_bytes())

    def test_dashboard_renders_public_chain(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            page = td / "page.html"
            summary = td / "summary.json"
            run = _run(DASHBOARD, "--log", str(COMMITTED_LOG),
                       "--page", str(page), "--summary", str(summary))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(page.read_bytes(), COMMITTED_PAGE.read_bytes())
            self.assertEqual(summary.read_bytes(), COMMITTED_SUMMARY.read_bytes())
            text = page.read_text(encoding="utf-8")
            self.assertIn("数据来源", text)
            self.assertIn("CC BY 4.0", text)
            self.assertIn("Open-Meteo", text)
            self.assertIn("degraded", text)
            self.assertIn("WO-0001", text)

    def test_dashboard_still_rejects_unknown_log(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            bad = td / "bad.json"
            bad.write_text("{}", encoding="utf-8")
            run = _run(DASHBOARD, "--log", str(bad),
                       "--page", str(td / "p.html"),
                       "--summary", str(td / "s.json"))
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)


if __name__ == "__main__":
    unittest.main()
