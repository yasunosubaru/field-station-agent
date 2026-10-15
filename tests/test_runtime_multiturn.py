"""runtime.run 多轮循环的测试：工具派发、人工审批门、截断保护、确定性。

向后兼容的硬约束（与 tests/test_runtime.py 同一口径，这里再钉一遍）：
  * 没有 tool_calls 时，事件仍是 run_start → provider_call → run_end 三个；
  * 这三个事件的 payload 键集合不变（kind / agent / i / input_digest）；
  * 同输入两次运行，trace 逐字节相同。
任何一条被破坏，M0-4 的回放基线就失效。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.agents import runtime
from fieldstation.agents.approval import ApprovalGate, ApproveAll, RejectAll
from fieldstation.agents.providers.base import ChatMessage, ChatResponse, Provider
from fieldstation.agents.tools import ToolRegistry
from fieldstation.agents.tools.qc_tools import robust_stats_tool
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter

Agent = runtime.Agent
ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "harness" / "agent_demo.py"


class RecordingProvider(Provider):
    """按脚本返回响应，同时记下每次 chat 收到的消息，用来验证工具结果有回喂。"""

    name = "recording"

    def __init__(self, responses):
        self._responses = [r if isinstance(r, ChatResponse)
                           else ChatResponse(content=r) for r in responses]
        self._i = 0
        self.seen: list[list[ChatMessage]] = []

    def chat(self, messages, tools):
        self.seen.append(list(messages))
        if self._i >= len(self._responses):
            raise RuntimeError("RecordingProvider 已用尽")
        r = self._responses[self._i]
        self._i += 1
        return r


def _tool_call(name, args):
    return ChatResponse(content="", tool_calls=[{"name": name, "args": args}])


class TestBackwardCompatible(unittest.TestCase):
    def test_no_tool_calls_gives_exactly_three_events(self):
        from fieldstation.agents.providers.fake import FakeProvider
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "t.jsonl"
            a = Agent(name="qc", system_prompt="s", provider=FakeProvider(["答"]), tools=[])
            runtime.run(a, "输入", TraceWriter(p), registry=ToolRegistry())
            self.assertEqual([e["kind"] for e in read_trace(p)],
                             ["run_start", "provider_call", "run_end"])

    def test_existing_three_events_keep_payload_keys(self):
        from fieldstation.agents.providers.fake import FakeProvider
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "t.jsonl"
            a = Agent(name="qc", system_prompt="s", provider=FakeProvider(["答"]), tools=[])
            runtime.run(a, "输入", TraceWriter(p), registry=ToolRegistry())
            for e in read_trace(p):
                self.assertEqual(set(e), {"kind", "agent", "i", "input_digest"})

    def test_no_registry_still_runs(self):
        """registry 不传也要能跑 —— 老调用方不该被逼着改。"""
        from fieldstation.agents.providers.fake import FakeProvider
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "t.jsonl"
            a = Agent(name="qc", system_prompt="s", provider=FakeProvider(["答"]), tools=[])
            out = runtime.run(a, "输入", TraceWriter(p))
            self.assertEqual(out, "答")


class TestToolDispatch(unittest.TestCase):
    def _setup(self, responses, gate=None):
        self.tmp = tempfile.TemporaryDirectory()
        p = Path(self.tmp.name) / "t.jsonl"
        prov = RecordingProvider(responses)
        reg = ToolRegistry()
        reg.register(robust_stats_tool())
        agent = Agent(name="qc", system_prompt="你是质控智能体", provider=prov,
                      tools=reg.describe())
        return p, prov, reg, agent

    def tearDown(self):
        self.tmp.cleanup()

    def test_tool_call_round_trip(self):
        p, prov, reg, agent = self._setup([
            _tool_call("robust_stats", {"values": [1.0, 1.1, 0.9, 9.0]}),
            "周跳在历元 4",
        ])
        out = runtime.run(agent, "看看有没有跳变", TraceWriter(p), registry=reg)
        self.assertEqual(out, "周跳在历元 4")
        kinds = [e["kind"] for e in read_trace(p)]
        self.assertEqual(kinds, ["run_start", "provider_call", "tool_call",
                                 "tool_result", "provider_call", "run_end"])

    def test_tool_result_is_fed_back_to_provider(self):
        """工具结果必须回喂给模型，否则它拿不到自己刚查到的数。"""
        p, prov, reg, agent = self._setup([
            _tool_call("robust_stats", {"values": [1.0, 2.0]}),
            "答",
        ])
        runtime.run(agent, "x", TraceWriter(p), registry=reg)
        second = prov.seen[1]
        roles = [m.role for m in second]
        self.assertIn("tool", roles)
        tool_msgs = [m for m in second if m.role == "tool"]
        self.assertIn("robust_stats", tool_msgs[0].content)

    def test_trace_records_tool_call_without_leaking_big_payload(self):
        p, prov, reg, agent = self._setup([
            _tool_call("robust_stats", {"values": [1.0, 2.0]}),
            "答",
        ])
        runtime.run(agent, "x", TraceWriter(p), registry=reg)
        call = [e for e in read_trace(p) if e["kind"] == "tool_call"][0]
        res = [e for e in read_trace(p) if e["kind"] == "tool_result"][0]
        self.assertEqual(call["tool"], "robust_stats")
        self.assertEqual(call["args"], {"values": [1.0, 2.0]})
        # 结果本体不进 trace，只留摘要 —— 否则 trace 会被大数组撑爆且难比对
        self.assertIn("result_digest", res)
        self.assertNotIn("data", res)

    def test_tool_failure_reported_not_raised(self):
        """工具报错要让模型看见，而不是把整个循环打崩。"""
        p, prov, reg, agent = self._setup([
            _tool_call("robust_stats", {"values": []}),
            "查不了，因为输入为空",
        ])
        out = runtime.run(agent, "x", TraceWriter(p), registry=reg)
        self.assertEqual(out, "查不了，因为输入为空")
        res = [e for e in read_trace(p) if e["kind"] == "tool_result"][0]
        self.assertFalse(res["ok"])
        self.assertIsNotNone(res["error"])

    def test_unknown_tool_recorded_as_failure(self):
        p, prov, reg, agent = self._setup([
            _tool_call("不存在的工具", {}),
            "换个工具",
        ])
        out = runtime.run(agent, "x", TraceWriter(p), registry=reg)
        self.assertEqual(out, "换个工具")
        res = [e for e in read_trace(p) if e["kind"] == "tool_result"][0]
        self.assertFalse(res["ok"])


class TestApprovalGateInLoop(unittest.TestCase):
    def _agent(self, responses, gate=None):
        reg = ToolRegistry()
        t = robust_stats_tool()
        t.risk = "high"          # 把这个工具升级为高风险，用来驱审批门
        reg.register(t)
        path = Path(self.tmp.name) / "t.jsonl"
        a = Agent(name="qc", system_prompt="s",
                  provider=RecordingProvider(responses), tools=reg.describe())
        return reg, path, a

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_high_risk_tool_blocked_when_rejected(self):
        """被拒的高风险工具不得真的执行 —— 这是「规则裁决」的安全底线。"""
        reg, path, agent = self._agent([
            _tool_call("robust_stats", {"values": [1.0, 2.0]}),
            "没人批，我不动",
        ], RejectAll())
        runtime.run(agent, "x", TraceWriter(path), registry=reg,
                    approval=ApprovalGate(approver=RejectAll()))
        res = [e for e in read_trace(path) if e["kind"] == "tool_result"][0]
        self.assertFalse(res["ok"])
        self.assertIn("批准", res["error"])
        appr = [e for e in read_trace(path) if e["kind"] == "approval"]
        self.assertEqual(len(appr), 1)
        self.assertEqual(appr[0]["verdict"], "rejected")

    def test_high_risk_tool_runs_when_approved(self):
        reg, path, agent = self._agent([
            _tool_call("robust_stats", {"values": [1.0, 2.0]}),
            "获批，已算",
        ], ApproveAll())
        runtime.run(agent, "x", TraceWriter(path), registry=reg,
                    approval=ApprovalGate(approver=ApproveAll()))
        res = [e for e in read_trace(path) if e["kind"] == "tool_result"][0]
        self.assertTrue(res["ok"])
        appr = [e for e in read_trace(path) if e["kind"] == "approval"]
        self.assertEqual(len(appr), 1)
        self.assertEqual(appr[0]["verdict"], "approved")

    def test_low_risk_tool_skips_approval(self):
        """低风险工具不该为每一句计算去烦人。"""
        reg = ToolRegistry()
        reg.register(robust_stats_tool())
        prov = RecordingProvider([
            _tool_call("robust_stats", {"values": [1.0, 2.0]}), "答"])
        agent = Agent(name="qc", system_prompt="s", provider=prov,
                      tools=reg.describe())
        path = Path(self.tmp.name) / "t.jsonl"
        runtime.run(agent, "x", TraceWriter(path), registry=reg,
                    approval=ApprovalGate(approver=RejectAll()))
        self.assertEqual([e for e in read_trace(path) if e["kind"] == "approval"], [])


class TestDeterminism(unittest.TestCase):
    def test_two_identical_multiturn_runs_produce_identical_trace(self):
        def one(path):
            reg = ToolRegistry()
            reg.register(robust_stats_tool())
            prov = RecordingProvider([
                _tool_call("robust_stats", {"values": [1.0, 2.0, 3.0, 50.0]}),
                "历元 4 是跳变",
            ])
            a = Agent(name="qc", system_prompt="s", provider=prov, tools=reg.describe())
            return runtime.run(a, "输入", TraceWriter(path), registry=reg)

        with tempfile.TemporaryDirectory() as td:
            p1, p2 = Path(td) / "a.jsonl", Path(td) / "b.jsonl"
            self.assertEqual(one(p1), one(p2))
            self.assertEqual(p1.read_text(encoding="utf-8"),
                             p2.read_text(encoding="utf-8"))


class TestTruncation(unittest.TestCase):
    def test_max_turns_stops_infinite_loop(self):
        """模型一直要求调工具时必须停下 —— 否则这是个死循环，而且 trace 无限长。"""
        reg = ToolRegistry()
        reg.register(robust_stats_tool())
        prov = RecordingProvider([
            _tool_call("robust_stats", {"values": [1.0, 2.0]})
            for _ in range(20)
        ])
        agent = Agent(name="qc", system_prompt="s", provider=prov, tools=reg.describe())
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "t.jsonl"
            runtime.run(agent, "x", TraceWriter(p), registry=reg, max_turns=3)
            kinds = [e["kind"] for e in read_trace(p)]
            self.assertIn("truncated", kinds)
            self.assertEqual(kinds.count("provider_call"), 3)


class TestAgentDemo(unittest.TestCase):
    """harness/agent_demo.py 必须真的能跑。

    它自己断言了两件事：高风险工具被审批门拦下、两次运行 trace 逐字节相同。
    这条测试是防止演示脚本悄悄烂掉 —— 一个跑不起来的示例比没有示例更糟，
    因为它让人以为这套运行时是活的。
    """

    def test_demo_runs_and_self_checks_pass(self):
        import os
        import subprocess
        import sys
        r = subprocess.run([sys.executable, str(DEMO)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=str(ROOT),
                           env={**os.environ, "PYTHONPATH": str(ROOT / "src"),
                                "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("[OK] 高风险工具被人工审批门拦下", r.stdout)
        self.assertIn("[OK] 两次运行 trace 逐字节相同", r.stdout)


if __name__ == "__main__":
    unittest.main()