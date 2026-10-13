"""智能体运行时最小核的测试（M0-3 的 TDD 落点）。

覆盖 provider 抽象（FakeProvider / get_provider）、确定性 trace 留痕
（TraceWriter / read_trace）、最小运行循环（runtime.run）。

两条硬性要求（分别由测试钉死）：
  * trace 确定性：同输入两次运行的 trace 逐字节相同 —— 这是 M0-4 回放式
    评测基线「同输入同输出」能成立的前提，故 trace 里不得含时间戳或随机量。
  * 事件顺序固定：run_start → provider_call → run_end，每个事件 payload 含
    agent（智能体名）、i（该事件之前已完成的 provider 调用次数，0 起）、
    input_digest（对用户输入做 SHA256 的前 16 位 hex）。

本文件只用标准库；不接真实模型（只用 FakeProvider）。
"""
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from fieldstation.agents import runtime
from fieldstation.agents.providers.base import (
    ChatMessage,
    ChatResponse,
    Provider,
    get_provider,
)
from fieldstation.agents.providers.fake import FakeProvider
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter

Agent = runtime.Agent


def _digest(s: str) -> str:
    """对用户输入做 SHA256 的前 16 位 hex，与 runtime 的口径一致。"""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def _make_agent() -> Agent:
    return Agent(
        name="qc",
        system_prompt="你是质控智能体",
        provider=FakeProvider(["周跳，源于载波跳变"]),
        tools=[],
    )


class TestChatTypes(unittest.TestCase):
    """把 ChatMessage / ChatResponse 的形状钉死。"""

    def test_chat_message_fields(self):
        m = ChatMessage(role="user", content="hi")
        self.assertEqual(m.role, "user")
        self.assertEqual(m.content, "hi")

    def test_chat_response_defaults(self):
        r = ChatResponse(content="ok")
        self.assertEqual(r.content, "ok")
        self.assertEqual(r.tool_calls, [])
        self.assertEqual(r.usage, {})


class TestFakeProvider(unittest.TestCase):
    def test_returns_configured_response(self):
        p = FakeProvider(["回答一"])
        self.assertEqual(p.chat([], []).content, "回答一")

    def test_exhausted_provider_raises(self):
        p = FakeProvider(["only"])
        p.chat([], [])
        with self.assertRaises(RuntimeError):
            p.chat([], [])

    def test_name_attribute(self):
        self.assertEqual(FakeProvider(["x"]).name, "fake")

    def test_is_a_provider(self):
        self.assertIsInstance(FakeProvider(["x"]), Provider)


class TestGetProvider(unittest.TestCase):
    def test_fake_returns_fake_provider(self):
        p = get_provider("fake", {"responses": ["a", "b"]})
        self.assertIsInstance(p, FakeProvider)
        self.assertEqual(p.chat([], []).content, "a")
        self.assertEqual(p.chat([], []).content, "b")

    def test_unknown_raises_value_error(self):
        with self.assertRaises(ValueError):
            get_provider("不存在", {})


class TestTrace(unittest.TestCase):
    def test_write_then_read_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            w = TraceWriter(path)
            w.write("provider_call", {"i": 0})
            w.write("provider_call", {"i": 1})
            self.assertEqual(
                read_trace(path),
                [{"kind": "provider_call", "i": 0},
                 {"kind": "provider_call", "i": 1}],
            )

    def test_read_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(read_trace(Path(td) / "nope.jsonl"), [])


class TestRun(unittest.TestCase):
    def test_run_emits_trace_and_returns_content(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            agent = _make_agent()
            out = runtime.run(agent, "2023-001 历元 400 有跳变", TraceWriter(path))
            self.assertEqual(out, "周跳，源于载波跳变")
            events = read_trace(path)
            self.assertEqual(
                [e["kind"] for e in events],
                ["run_start", "provider_call", "run_end"],
            )

    def test_event_payload_shape(self):
        """把每个事件的 payload 钉死：agent / i / input_digest，无多余字段。

        这同时是一条显式守卫：payload 里**不得**出现时间戳或随机量
        （键集合固定为四元组），否则回放基线无从成立。
        """
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            runtime.run(_make_agent(), "2023-001 历元 400 有跳变", TraceWriter(path))
            digest = _digest("2023-001 历元 400 有跳变")
            events = read_trace(path)
            self.assertEqual(len(events), 3)
            self.assertEqual(events[0], {"kind": "run_start", "agent": "qc",
                                         "i": 0, "input_digest": digest})
            self.assertEqual(events[1], {"kind": "provider_call", "agent": "qc",
                                         "i": 0, "input_digest": digest})
            self.assertEqual(events[2], {"kind": "run_end", "agent": "qc",
                                         "i": 1, "input_digest": digest})

    def test_two_identical_runs_produce_identical_trace(self):
        """同输入两次运行，trace 逐字节相同 —— 回放基线的前提。

        trace 里若有时间戳或随机量，本测试必红。
        """
        with tempfile.TemporaryDirectory() as td:
            p1 = Path(td) / "a.jsonl"
            p2 = Path(td) / "b.jsonl"
            out1 = runtime.run(_make_agent(), "2023-001 历元 400 有跳变",
                               TraceWriter(p1))
            out2 = runtime.run(_make_agent(), "2023-001 历元 400 有跳变",
                               TraceWriter(p2))
            self.assertEqual(out1, out2)
            self.assertEqual(p1.read_text(encoding="utf-8"),
                             p2.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
