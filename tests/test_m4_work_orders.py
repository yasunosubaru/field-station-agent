"""M4-3：工单状态机、高风险动作审批与 trace。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.agents import runtime
from fieldstation.agents.approval import ApprovalGate, ApproveAll, RejectAll
from fieldstation.agents.providers.base import ChatResponse
from fieldstation.agents.providers.fake import FakeProvider
from fieldstation.agents.tools import ToolRegistry
from fieldstation.agents.tools.work_order_tools import (
    CreateWorkOrderTool,
    ExecuteDeviceActionTool,
)
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter
from fieldstation.store.work_order import WorkOrderService


class TestWorkOrderService(unittest.TestCase):
    def setUp(self):
        self.service = WorkOrderService()

    def test_create_and_schedule(self):
        order = self.service.create(
            station_id="BADG", title="网络链路中断",
            priority="P0", risk="medium",
            description="4G 链路连续 30 分钟无上报",
            evidence_call_ids=["t0001"])
        self.assertEqual(order.order_id, "WO-0001")
        self.assertEqual(order.status, "open")
        scheduled = self.service.transition("WO-0001", "scheduled")
        self.assertEqual(scheduled.status, "scheduled")

    def test_invalid_transition_rejected(self):
        self.service.create(station_id="BADG", title="检查",
                            priority="P2", risk="low")
        with self.assertRaises(ValueError):
            self.service.transition("WO-0001", "done")

    def test_high_risk_requires_gate(self):
        self.service.create(station_id="BADG", title="重启接收机",
                            priority="P0", risk="high",
                            evidence_call_ids=["t0001"])
        with self.assertRaises(ValueError):
            self.service.decide("WO-0001", gate=None)
        record = self.service.decide(
            "WO-0001", gate=ApprovalGate(approver=RejectAll()),
            confidence=0.99)
        self.assertEqual(record.verdict, "rejected")
        self.assertEqual(self.service.get("WO-0001").status, "rejected")

    def test_create_tool_returns_order(self):
        tool = CreateWorkOrderTool(self.service)
        result = tool.invoke({
            "station_id": "BADG",
            "title": "传感器漂移",
            "priority": "P1",
            "risk": "medium",
            "description": "持续偏离基线",
            "evidence_call_ids": ["t0002"],
        })
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["order_id"], "WO-0001")


class TestApprovalTrace(unittest.TestCase):
    def _run(self, approver):
        service = WorkOrderService()
        reg = ToolRegistry()
        reg.register(ExecuteDeviceActionTool())
        reg.register(CreateWorkOrderTool(service))
        provider = FakeProvider([
            ChatResponse(content="", tool_calls=[{
                "name": "execute_device_action",
                "args": {
                    "station_id": "BADG",
                    "action": "restart_receiver",
                    "reason": "连续失联",
                    "confidence": 0.99,
                },
            }]),
            "动作流程结束",
        ])
        agent = runtime.Agent(name="operations_dispatch", system_prompt="s",
                              provider=provider, tools=reg.describe())
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "trace.jsonl"
            out = runtime.run(
                agent, "处理失联", TraceWriter(path), registry=reg,
                approval=ApprovalGate(approver=approver))
            events = read_trace(path)
        return out, events

    def test_rejected_high_risk_action_stops(self):
        out, events = self._run(RejectAll())
        self.assertEqual(out, "动作流程结束")
        approval = [e for e in events if e["kind"] == "approval"]
        result = [e for e in events if e["kind"] == "tool_result"][0]
        self.assertEqual(approval[0]["verdict"], "rejected")
        self.assertFalse(result["ok"])
        self.assertIn("批准", result["error"])

    def test_approved_high_risk_action_runs_and_traces(self):
        _out, events = self._run(ApproveAll())
        approval = [e for e in events if e["kind"] == "approval"]
        result = [e for e in events if e["kind"] == "tool_result"][0]
        self.assertEqual(approval[0]["verdict"], "approved")
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
