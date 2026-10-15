"""智能体工具层与人工审批门的测试（M3 之前的框架无关层）。

这层不依赖数据字典、不接真实模型：把 spec §4 里推迟到 M3 的三项能力中
**框架无关**的两件先做实（工具注册、人工审批门），第三件（消息路由/共享黑板）
留给框架的 state，不自造。

为什么现在做而不是等 M3：这三样不管最后选 LangGraph 还是 Pydantic AI 都要用，
且「规则裁决，模型归因」这条设计约束要求**高风险动作必须经过人工审批门** ——
那是合规要求，不是可选项，晚做只会让它被绕过去。
"""
from __future__ import annotations

import json
import unittest

from fieldstation.agents.approval import (
    ApprovalGate,
    ApprovalRequest,
    ApproveAll,
    RejectAll,
)
from fieldstation.agents.tools import ToolRegistry, ToolResult
from fieldstation.agents.tools.qc_tools import robust_stats_tool


class TestToolRegistry(unittest.TestCase):
    def test_register_then_get(self):
        r = ToolRegistry()
        r.register(robust_stats_tool())
        self.assertIsNotNone(r.get("robust_stats"))

    def test_duplicate_name_rejected(self):
        """重名必须报错，不能静默覆盖 —— 静默覆盖会让一个工具顶着另一个工具的名字
        被调用，而调用方看到的还是原来那个名字。"""
        r = ToolRegistry()
        r.register(robust_stats_tool())
        with self.assertRaises(ValueError):
            r.register(robust_stats_tool())

    def test_get_unknown_returns_none(self):
        self.assertIsNone(ToolRegistry().get("不存在"))

    def test_invoke_unknown_raises(self):
        with self.assertRaises(KeyError):
            ToolRegistry().invoke("不存在", {})

    def test_describe_lists_registered_tools(self):
        """describe() 是喂给 provider 的形状，必须每项都有 name/description/params。"""
        r = ToolRegistry()
        r.register(robust_stats_tool())
        d = r.describe()
        self.assertEqual(len(d), 1)
        self.assertEqual(set(d[0]), {"name", "description", "params", "risk"})

    def test_empty_registry_describe_is_empty(self):
        self.assertEqual(ToolRegistry().describe(), [])


class TestRobustStatsTool(unittest.TestCase):
    def setUp(self):
        self.tool = robust_stats_tool()

    def test_matches_rules_module(self):
        """工具的返回值必须与 rules/qc.py 的纯函数一致 —— 工具是适配层，不是重新实现。"""
        from fieldstation.rules import qc
        values = [1.0, 1.2, 0.9, 5.0, 1.1, 1.05]
        res = self.tool.invoke({"values": values})
        self.assertTrue(res.ok, res.error)
        self.assertEqual(res.data["median"], qc.median(values))
        self.assertEqual(res.data["mad"], qc.mad(values))
        self.assertEqual(res.data["robust_z"], qc.robust_z(values))
        self.assertEqual(res.data["n"], len(values))

    def test_result_data_is_json_serializable(self):
        """trace 要能序列化工具结果 —— 不可序列化的返回会让回放评测崩在中间。"""
        res = self.tool.invoke({"values": [1.0, 2.0, 3.0]})
        json.dumps(res.data, sort_keys=True)

    def test_empty_values_rejected_not_raised(self):
        res = self.tool.invoke({"values": []})
        self.assertFalse(res.ok)
        self.assertIsNotNone(res.error)

    def test_non_numeric_rejected_not_raised(self):
        res = self.tool.invoke({"values": [1.0, "abc"]})
        self.assertFalse(res.ok)

    def test_missing_arg_rejected(self):
        res = self.tool.invoke({})
        self.assertFalse(res.ok)


class TestApprovalGate(unittest.TestCase):
    def _req(self, confidence=0.99, risk="low", action="submit_ticket"):
        return ApprovalRequest(agent="qc", action=action, reason="周跳",
                               confidence=confidence, risk=risk)

    def test_low_risk_high_confidence_needs_no_approval(self):
        g = ApprovalGate(approver=RejectAll())
        self.assertFalse(g.needs_approval(self._req()))

    def test_low_confidence_needs_approval(self):
        g = ApprovalGate(confidence_threshold=0.9, approver=RejectAll())
        self.assertTrue(g.needs_approval(self._req(confidence=0.4)))

    def test_high_risk_needs_approval_regardless_of_confidence(self):
        """高风险一律要人批，模型再自信也不许自己拍板。"""
        g = ApprovalGate(confidence_threshold=0.9, approver=RejectAll())
        self.assertTrue(g.needs_approval(self._req(confidence=0.99, risk="high")))

    def test_no_approval_needed_returns_approved_without_asking(self):
        g = ApprovalGate(approver=RejectAll())
        rec = g.decide(self._req())
        self.assertEqual(rec.verdict, "approved")
        self.assertEqual(rec.by, "auto")

    def test_reject_all_yields_rejected(self):
        g = ApprovalGate(approver=RejectAll())
        rec = g.decide(self._req(confidence=0.1))
        self.assertEqual(rec.verdict, "rejected")

    def test_approve_all_yields_approved(self):
        g = ApprovalGate(approver=ApproveAll())
        rec = g.decide(self._req(confidence=0.1))
        self.assertEqual(rec.verdict, "approved")

    def test_risk_levels_configurable(self):
        g = ApprovalGate(approver=RejectAll(), risk_needing_approval=("medium",))
        self.assertTrue(g.needs_approval(self._req(risk="medium")))
        self.assertFalse(g.needs_approval(self._req(risk="high")))


class TestApprovalRecordDeterminism(unittest.TestCase):
    def test_record_has_no_timestamp(self):
        """审批记录要进 trace，故不含时间戳或随机量。"""
        rec = RejectAll().decide(ApprovalRequest(agent="qc", action="a",
                                                 reason="r", confidence=0.1, risk="high"))
        json.dumps(rec.__dict__, sort_keys=True)
        self.assertNotIn("at", rec.__dict__)
        self.assertNotIn("time", rec.__dict__)


if __name__ == "__main__":
    unittest.main()