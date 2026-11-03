#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``workflow`` 子命令：目录、校验、闸门与退出码。

不碰网络：唯一「运行」的用例停在**工作流级审批门**，在发任何 HTTP 之前就返回，
所以可以把整条 CLI 链路（argparse → service → store → 退出码）跑完。
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


def _run(*args):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "workflow_cli.py"), *args],
        cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
        errors="replace", env=env, timeout=120)
    return result.returncode, (result.stdout or "") + (result.stderr or "")


class Catalog(unittest.TestCase):
    def test_validate_all_shipped_workflows(self):
        code, out = _run("validate")
        self.assertEqual(code, 0, out)
        self.assertIn("script.device.restart", out)
        self.assertIn("gui.device.update", out)
        self.assertIn("gui.graph.export", out)

    def test_list_shows_workflows(self):
        code, out = _run("list")
        self.assertEqual(code, 0, out)
        self.assertIn("script.device.restart", out)
        self.assertIn("共 8 条", out)

    def test_list_json_is_machine_readable(self):
        code, out = _run("list", "--json")
        self.assertEqual(code, 0, out)
        rows = json.loads(out)
        ids = {row["id"] for row in rows}
        self.assertIn("gui.graph.export", ids)
        for row in rows:
            self.assertIn("params", row)
            self.assertIn("steps", row)

    def test_list_filtered_by_intent(self):
        code, out = _run("list", "--intent", "graph")
        self.assertEqual(code, 0, out)
        self.assertIn("gui.graph.export", out)
        self.assertNotIn("script.device.restart", out)

    def test_describe_reports_gates_and_params(self):
        code, out = _run("describe", "gui.device.update", "--json")
        self.assertEqual(code, 0, out)
        data = json.loads(out)
        self.assertIn("approve_apply", data["gate_steps"])
        self.assertEqual(data["required_params"], ["firmware", "model"])

    def test_describe_unknown_workflow_is_usage_error(self):
        code, out = _run("describe", "no.such")
        self.assertEqual(code, 2, out)
        self.assertIn("没有工作流", out)

    def test_validate_reports_bad_spec(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.yaml"
            path.write_text("id: Bad\nversion: 0\n", encoding="utf-8")
            code, out = _run("validate", str(path))
            self.assertEqual(code, 1, out)
            self.assertIn("错误", out)


class Gates(unittest.TestCase):
    def test_run_waits_then_reject_cancels(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs = Path(tmp) / "jobs"
            code, out = _run("run", "script.device.restart", "--jobs-root", str(jobs),
                             "--json")
            self.assertEqual(code, 3, out)
            view = json.loads(out)
            self.assertEqual(view["status"], "waiting_approval")
            job_id = view["job_id"]

            code, out = _run("gate", job_id, "--decision", "rejected",
                             "--by", "tester", "--note", "dry run",
                             "--jobs-root", str(jobs))
            self.assertEqual(code, 0, out)
            self.assertIn("cancelled", out)

            code, out = _run("status", job_id, "--jobs-root", str(jobs))
            self.assertEqual(code, 1, out)  # 终态非 succeeded → 1
            self.assertIn("cancelled", out)

    def test_run_missing_required_param_is_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = _run("run", "gui.device.update", "--jobs-root",
                             str(Path(tmp) / "jobs"))
            self.assertEqual(code, 2, out)
            self.assertIn("firmware", out)

    def test_unknown_job_is_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = _run("status", "demo.flow-20260101T000000Z-abcdef",
                             "--jobs-root", str(Path(tmp) / "jobs"))
            self.assertEqual(code, 2, out)

    def test_capabilities_survives_engine_down(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = _run("capabilities", "--engine", "http://127.0.0.1:1",
                             "--jobs-root", str(Path(tmp) / "jobs"), "--json")
            self.assertEqual(code, 0, out)
            data = json.loads(out)
            self.assertFalse(data["engine"]["reachable"])
            self.assertGreaterEqual(data["workflow_count"], 3)
            self.assertEqual(data["gui"]["name"], "assisted")


if __name__ == "__main__":
    unittest.main()
