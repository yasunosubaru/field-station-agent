"""M4 Agent 声明式配置与端到端契约复用。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.agents import runtime
from fieldstation.agents.conclusion import ConclusionContract
from fieldstation.agents.config import build, load_agent_config
from fieldstation.agents.knowledge import KnowledgeBase, knowledge_search_tool, load_documents
from fieldstation.agents.providers.base import ChatResponse
from fieldstation.agents.providers.fake import FakeProvider
from fieldstation.agents.tools import ToolRegistry
from fieldstation.agents.tools.archive_tools import ArchiveExportTool
from fieldstation.agents.tools.qc_tools import (
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
)
from fieldstation.agents.tools.station_tools import station_health_tool
from fieldstation.agents.tools.work_order_tools import (
    CreateWorkOrderTool,
    ExecuteDeviceActionTool,
)
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter
from fieldstation.store.work_order import WorkOrderService

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config" / "agents"
KB_DOCS = ROOT / "data" / "kb" / "knowledge.jsonl"


def _base(tmp: Path) -> ToolRegistry:
    kb = KnowledgeBase(tmp / "kb.sqlite3")
    kb.index(load_documents(KB_DOCS))
    reg = ToolRegistry()
    for tool in (
        knowledge_search_tool(kb),
        station_health_tool(),
        robust_stats_tool(),
        continuity_verdict_tool(),
        magnitude_verdict_tool(),
        CreateWorkOrderTool(WorkOrderService()),
        ExecuteDeviceActionTool(),
        ArchiveExportTool(tmp / "archive"),
    ):
        reg.register(tool)
    return reg


class TestM4Configs(unittest.TestCase):
    def test_all_agent_configs_build_without_runtime_changes(self):
        expected = {
            "device_monitor": {"knowledge_search", "station_health"},
            "fault_diagnosis": {
                "continuity_verdict", "knowledge_search",
                "magnitude_verdict", "robust_stats", "station_health"},
            "operations_dispatch": {
                "create_work_order", "execute_device_action",
                "knowledge_search", "station_health"},
            "archive": {"archive_export", "knowledge_search"},
        }
        with tempfile.TemporaryDirectory() as td:
            base = _base(Path(td))
            for name, tools in expected.items():
                with self.subTest(name=name):
                    cfg = load_agent_config(CONFIG_DIR / f"{name}.json")
                    agent, scoped = build(cfg, FakeProvider(["答"]), base)
                    self.assertEqual(set(scoped.names()), tools)
                    self.assertEqual({t["name"] for t in agent.tools}, tools)

    def test_fault_diagnosis_uses_two_tools_and_contract(self):
        conclusion = {
            "attribution": {
                "fault_type": "nonphysical_rmse",
                "evidence": [
                    {"call_id": "t0001", "tool": "knowledge_search",
                     "finding": "检索到非物理 RMSE 规程"},
                    {"call_id": "t0002", "tool": "station_health",
                     "finding": "台站健康度正常，问题集中在反演输出"},
                ],
            },
            "recommendation": "拒绝反演结果并复查定平链路",
            "confidence": 0.97,
        }
        provider = FakeProvider([
            ChatResponse(content="", tool_calls=[
                {"name": "knowledge_search",
                 "args": {"query": "非物理 RMSE", "limit": 3}},
                {"name": "station_health",
                 "args": {"readings": [{
                     "station_id": "BADG", "sensor": "power",
                     "metric": "voltage", "value": 12.0, "unit": "V",
                     "observed_at": "2026-10-18T10:00:00+00:00",
                     "quality_flag": ""}]}},
            ]),
            json.dumps(conclusion, ensure_ascii=False),
        ])
        with tempfile.TemporaryDirectory() as td:
            base = _base(Path(td))
            cfg = load_agent_config(CONFIG_DIR / "fault_diagnosis.json")
            agent, scoped = build(cfg, provider, base)
            trace = Path(td) / "trace.jsonl"
            out = runtime.run(
                agent, "研判非物理 RMSE", TraceWriter(trace),
                registry=scoped, contract=ConclusionContract(),
                capture_tool_results=True)
            events = read_trace(trace)
        self.assertEqual(json.loads(out), conclusion)
        valid = [e for e in events if e["kind"] == "conclusion_valid"][0]
        self.assertEqual(valid["evidence_call_ids"], ["t0001", "t0002"])

    def test_high_risk_action_is_declared_high(self):
        tool = ExecuteDeviceActionTool()
        self.assertEqual(tool.risk, "high")
        action_cfg = json.loads(
            (ROOT / "config/actions/high_risk.json").read_text(encoding="utf-8"))
        self.assertIn("restart_receiver", action_cfg["high_risk_actions"])

    def test_agent_boundary_doc_is_explicit(self):
        text = (ROOT / "docs/operations/agent-boundaries.md").read_text(
            encoding="utf-8")
        self.assertIn("质控 Agent", text)
        self.assertIn("研判 Agent", text)
        self.assertIn("不重新实现", text)


if __name__ == "__main__":
    unittest.main()
