"""公开数据全流程演示（结题标准演示）的行为钉死。

重点不是「跑通了」，而是**结论里的数字确实来自工具返回**：QC 的 counts、
设备的健康度与质量标记、工单号、审批记录、归档 sha 都要能在记录里对上；
演示记录还要可复现（两次运行逐字节相同、与入库版本一致）。
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
DEMO = ROOT / "harness" / "public_data_full_run.py"
COMMITTED_LOG = ROOT / "logs" / "public_data_full_run_202401d01.json"


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(DEMO), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=300)


class TestPublicDataFullRun(unittest.TestCase):
    def _run_demo(self, td: Path) -> tuple[subprocess.CompletedProcess, dict]:
        out = td / "run.json"
        run = _run("--out", str(out))
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        return run, json.loads(out.read_text(encoding="utf-8"))

    def test_all_checks_pass(self):
        with tempfile.TemporaryDirectory() as td:
            run, log = self._run_demo(Path(td))
            self.assertIn("checks 8/8", run.stdout)
            self.assertEqual(log["summary"], {"checks": "8/8", "messages": 7,
                                              "stages": 5})
            failed = [name for name, ok in log["checks"].items() if not ok]
            self.assertEqual(failed, [], failed)

    def test_conclusions_are_derived_from_tool_results(self):
        """结论里的数字必须来自工具返回，而不是写死的文案。"""
        with tempfile.TemporaryDirectory() as td:
            _, log = self._run_demo(Path(td))
            stages = {s["stage"]: s for s in log["chain"]["stages"]}

            qc = stages["qc"]["conclusion"]["attribution"]
            self.assertEqual(qc["fault_type"], "phase_slip_detected")
            self.assertIn("union': 1", qc["evidence"][0]["finding"])
            self.assertIn("slip_indices=[30]", qc["evidence"][0]["finding"])
            self.assertIn("union': 0", qc["evidence"][1]["finding"])

            device = stages["device_monitor"]["conclusion"]["attribution"]
            self.assertEqual(device["fault_type"], "device_quality_flag")
            self.assertIn("degraded", device["evidence"][0]["finding"])
            self.assertIn("low_temp", device["evidence"][0]["finding"])

            diagnosis = stages["fault_diagnosis"]["conclusion"]["attribution"]
            self.assertEqual(diagnosis["fault_type"],
                             "phase_slip_with_device_degradation")
            self.assertIn("qc-phase-slip", diagnosis["evidence"][0]["finding"])

            dispatch = stages["operations_dispatch"]["artifacts"]
            self.assertEqual(dispatch["work_order"]["order_id"], "WO-0001")
            self.assertEqual(dispatch["work_order"]["priority"], "P1")
            self.assertEqual(dispatch["device_action"]["status"], "accepted")
            self.assertEqual(dispatch["device_action"]["execution_mode"],
                             "simulated")

            archive = stages["archive"]["artifacts"]["archive"]
            self.assertIn("synthetic/", archive["path"])
            self.assertTrue(archive["sha256"])

    def test_approval_recorded_for_high_risk_action(self):
        with tempfile.TemporaryDirectory() as td:
            _, log = self._run_demo(Path(td))
            self.assertEqual(len(log["approval"]), 1)
            record = log["approval"][0]
            self.assertEqual(record["verdict"], "approved")
            self.assertEqual(record["by"], "approve_all")
            self.assertEqual(record["action"], "execute_device_action")
            self.assertEqual(record["risk"], "high")

    def test_evidence_call_ids_resolve_to_successful_tool_calls(self):
        with tempfile.TemporaryDirectory() as td:
            _, log = self._run_demo(Path(td))
            for stage in log["chain"]["stages"]:
                ok_calls = {call["call_id"] for call in stage["tool_calls"]
                            if call["ok"]}
                for item in stage["conclusion"]["attribution"]["evidence"]:
                    self.assertIn(item["call_id"], ok_calls,
                                  f"{stage['stage']} 的证据 {item['call_id']} "
                                  "没有对应的成功工具调用")

    def test_public_and_synthetic_sources_are_labelled(self):
        with tempfile.TemporaryDirectory() as td:
            _, log = self._run_demo(Path(td))
            device = log["data_sources"]["device"]
            self.assertEqual(device["kind"], "public")
            self.assertEqual(device["license"], "CC BY 4.0")
            self.assertEqual(device["n_readings"], 96)
            self.assertEqual(device["n_low_temp_flagged"], 12)
            observations = log["data_sources"]["observations"]
            self.assertEqual(observations["kind"], "synthetic")
            self.assertIn("CRINEX", observations["reason"])

    def test_output_is_deterministic_and_matches_committed(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            first, second = td / "a.json", td / "b.json"
            for out in (first, second):
                run = _run("--out", str(out))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertNotIn(b"\r\n", first.read_bytes())
            self.assertEqual(
                first.read_bytes(), COMMITTED_LOG.read_bytes(),
                "logs/public_data_full_run_202401d01.json 与演示输出不一致："
                "重新运行 harness/public_data_full_run.py 并提交")


if __name__ == "__main__":
    unittest.main()
