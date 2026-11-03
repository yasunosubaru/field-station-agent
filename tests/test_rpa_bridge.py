#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RpaBridge：真跑 ``tools/workflow_cli.py`` 的目录、闸门与退出码。

这里**不 mock CLI**：桥的价值就是把 argparse → service → store → 退出码这条链路
真实跑通，mock 掉就只剩自己在测自己的假数据。代价是要挑不依赖网络与 GUI 的用例：

* ``list`` / ``describe`` / ``artifacts`` 只读目录；
* ``script.device.restart`` 的审批门在发任何 HTTP 之前就停下 → 正好验证
  「退出码 3 不是失败」，再用 ``gate rejected`` 把 job 正常取消；
* ``gui.graph.export`` 指到一个必然连不上的引擎 → 验证失败路径把 ``status`` 与
  失败原因折进 ``error``。

每次运行都用临时 ``--jobs-root``：不能往仓库的 ``workflows/jobs`` 里堆测试 job。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fieldstation.agents.tools.rpa_bridge import (
    RpaBridge,
    build_rpa_tools,
    extract_json,
)

ROOT = Path(__file__).resolve().parents[1]
#: 必然连不上的引擎地址（端口 1 不会有服务监听）。
DEAD_ENGINE = "http://127.0.0.1:1"


class TestExtractJson(unittest.TestCase):
    def test_pretty_printed_document_is_parsed(self):
        text = '提示行\n{\n  "ok": true,\n  "n": 1\n}\n'
        self.assertEqual(extract_json(text), {"ok": True, "n": 1})

    def test_single_line_document_is_parsed(self):
        self.assertEqual(extract_json('[{"id": "a"}]'), [{"id": "a"}])

    def test_empty_or_noise_returns_none(self):
        self.assertIsNone(extract_json(""))
        self.assertIsNone(extract_json("[错误] 没有工作流"))


class _BridgeCase(unittest.TestCase):
    """每个用例一个临时 jobs-root，互不抢工作流锁。"""

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.jobs = Path(self._tmp.name) / "jobs"
        self.bridge = RpaBridge(ROOT, sys.executable, timeout_s=180,
                                jobs_root=self.jobs, engine=DEAD_ENGINE,
                                driver="scripted")


class Catalog(_BridgeCase):
    def test_list_returns_shipped_workflows(self):
        result = self.bridge.list()
        self.assertTrue(result.ok, result.error)
        ids = {row["id"] for row in result.data["workflows"]}
        self.assertIn("gui.graph.export", ids)
        self.assertIn("script.device.restart", ids)
        self.assertEqual(result.data["count"], len(result.data["workflows"]))
        for row in result.data["workflows"]:
            self.assertIn(row["risk"], ("low", "medium", "high"))
            self.assertIsInstance(row["params"], dict)

    def test_list_filters_by_intent(self):
        result = self.bridge.list("graph")
        self.assertTrue(result.ok, result.error)
        ids = {row["id"] for row in result.data["workflows"]}
        self.assertIn("gui.graph.export", ids)
        self.assertNotIn("script.device.restart", ids)

    def test_describe_returns_spec(self):
        result = self.bridge.describe("gui.graph.export")
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["id"], "gui.graph.export")
        self.assertEqual(result.data["risk"], "low")
        self.assertIn("required_params", result.data)
        self.assertIn("gate_steps", result.data)
        self.assertTrue(result.data["steps"])

    def test_describe_unknown_workflow_is_error(self):
        result = self.bridge.describe("no.such.workflow")
        self.assertFalse(result.ok)
        self.assertIn("没有工作流", result.error)
        self.assertIsInstance(result.error, str)

    def test_describe_requires_workflow(self):
        self.assertFalse(self.bridge.describe("").ok)
        self.assertFalse(self.bridge.describe(None).ok)


class Gates(_BridgeCase):
    def test_run_stops_at_gate_and_exit_3_is_not_failure(self):
        result = self.bridge.run("script.device.restart")
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["status"], "waiting_approval")
        self.assertTrue(result.data["waiting"])
        self.assertEqual(result.data["exit_code"], 3)
        job_id = result.data["job_id"]
        self.assertTrue(job_id)
        self.assertTrue(result.data["next_actions"])

        status = self.bridge.status(job_id)
        self.assertTrue(status.ok, status.error)
        self.assertEqual(status.data["status"], "waiting_approval")

        # 拒绝是人的正常选择：job 变成 cancelled，但 gate 命令本身成功。
        rejected = self.bridge.gate(job_id, "rejected", by="tester",
                                    note="dry run")
        self.assertTrue(rejected.ok, rejected.error)
        self.assertEqual(rejected.data["status"], "cancelled")

        artifacts = self.bridge.artifacts(job_id)
        self.assertTrue(artifacts.ok, artifacts.error)
        self.assertIsInstance(artifacts.data["artifacts"], list)

    def test_gate_rejects_illegal_decision_without_touching_disk(self):
        result = self.bridge.gate("demo.flow-20260101T000000Z-abcdef", "maybe")
        self.assertFalse(result.ok)
        self.assertIn("approved", result.error)
        self.assertIn("rejected", result.error)

    def test_resume_rejects_illegal_decision(self):
        result = self.bridge.resume("demo.flow-20260101T000000Z-abcdef",
                                    "approved")
        self.assertFalse(result.ok)
        self.assertIn("done", result.error)
        self.assertIn("failed", result.error)

    def test_gate_requires_job_id(self):
        self.assertFalse(self.bridge.gate("", "approved").ok)
        self.assertFalse(self.bridge.resume("   ", "done").ok)

    def test_status_of_unknown_job_is_error(self):
        result = self.bridge.status("demo.flow-20260101T000000Z-abcdef")
        self.assertFalse(result.ok)
        self.assertIn("读不到 job", result.error)


class Failures(_BridgeCase):
    def test_run_against_dead_engine_reports_failed_job(self):
        result = self.bridge.run("gui.graph.export")
        self.assertFalse(result.ok)
        self.assertIn("status=failed", result.error)
        self.assertIn("job ", result.error)

    def test_run_unknown_workflow_is_error(self):
        result = self.bridge.run("no.such.workflow")
        self.assertFalse(result.ok)
        self.assertIn("没有工作流", result.error)

    def test_run_rejects_non_object_params(self):
        result = self.bridge.run("gui.graph.export", ["project", "csv"])
        self.assertFalse(result.ok)
        self.assertIn("params", result.error)

    def test_timeout_is_reported_as_timeout(self):
        fast = RpaBridge(ROOT, sys.executable, timeout_s=0.001)
        result = fast.list()
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "timeout")


class ToolAdapters(_BridgeCase):
    def test_build_rpa_tools_covers_contract_names(self):
        tools = build_rpa_tools(self.bridge)
        self.assertEqual([tool.name for tool in tools], [
            "workflow_list", "workflow_describe", "workflow_status",
            "workflow_artifacts", "workflow_run", "workflow_resume",
            "workflow_cancel", "workflow_gate",
        ])
        by_name = {tool.name: tool for tool in tools}
        self.assertEqual(by_name["workflow_gate"].risk, "high")
        self.assertEqual(by_name["workflow_resume"].risk, "medium")
        self.assertEqual(by_name["workflow_cancel"].risk, "medium")
        self.assertEqual(by_name["workflow_list"].risk, "low")

    def test_run_risk_for_follows_workflow_spec(self):
        tool = {tool.name: tool for tool in build_rpa_tools(self.bridge)}[
            "workflow_run"]
        self.assertEqual(tool.risk_for({"workflow": "script.device.restart"}),
                         "high")
        self.assertEqual(tool.risk_for({"workflow": "gui.graph.export"}),
                         "low")
        # 查不到就按更严的算，不能把未知风险当成低风险放过去。
        self.assertEqual(tool.risk_for({"workflow": "no.such.workflow"}),
                         "high")

    def test_tool_invoke_runs_command(self):
        tool = {tool.name: tool for tool in build_rpa_tools(self.bridge)}[
            "workflow_describe"]
        result = tool.invoke({"workflow": "gui.graph.export"})
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["id"], "gui.graph.export")


if __name__ == "__main__":
    unittest.main()
