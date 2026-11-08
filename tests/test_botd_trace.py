# -*- coding: utf-8 -*-
"""Bot-4 验收：checkpointer + trace 接线。

计划书这条只有一句验收：「中断后按 ``last_event_seq + 1`` 续跑，不重复发消息」。

这句话里藏着两个容易写空的地方，所以这个文件盯的是它们：

1. **序号必须只有一个来源。** 两个写者迟早不一致。这里约定 trace 文件的行号
   就是序号，``thread.last_event_seq`` 只是它的缓存（``TraceLedger``）。
2. **"不重复发消息"要用消息条数验证**，不是"看起来没重复"。所以断言是
   "续跑后的总条数 == 只跑一次时的总条数"。

另外覆盖：文件被截断过（库里序号比文件行数大）时**以文件为准**并纠正缓存 ——
静默沿用旧值会让续跑跳过真实事件。
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fieldstation.agents.bus import MessageBus
from fieldstation.agents.pipeline import PipelineStage
from fieldstation.agents.runtime import Agent
from fieldstation.agents.tools import ToolRegistry
from fieldstation.botd.store import BotStore
from fieldstation.graph.checkpoint import CheckpointStore, TraceLedger

NOW = datetime(2026, 11, 8, 12, 0, 0, tzinfo=timezone.utc)


class _Scripted:
    """最简 provider：不调模型。"""

    def complete(self, *_args, **_kwargs):
        return {"content": "{}"}


def _stage(name: str, registry) -> PipelineStage:
    agent = Agent(name=name, system_prompt="", provider=_Scripted())
    return PipelineStage(name=name, agent=agent, registry=registry, topic=f"t.{name}")


class LedgerTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.store = BotStore(self.dir / "botd.sqlite")
        self.trace = self.dir / "trace" / "run.jsonl"
        self.thread = self.store.create_thread(
            runtime="claude", external_thread_id="ext-1",
            checkpointer_ns="langgraph", trace_path=str(self.trace), now=NOW)
        self.ledger = TraceLedger(self.store, self.trace)

    def tearDown(self) -> None:
        self._tmp.cleanup()


class TestTraceLedger(LedgerTestBase):
    def test_empty_trace_is_seq_zero(self) -> None:
        self.assertEqual(self.ledger.line_count(), 0)
        self.assertEqual(self.ledger.sync(self.thread["thread_id"]), 0)

    def test_append_advances_the_seq(self) -> None:
        seq = self.ledger.append(self.thread["thread_id"], "message", {"topic": "a"})
        self.assertEqual(seq, 1)
        self.assertEqual(
            self.store.get_thread(self.thread["thread_id"])["last_event_seq"], 1)
        seq = self.ledger.append(self.thread["thread_id"], "message", {"topic": "b"})
        self.assertEqual(seq, 2)

    def test_seq_equals_trace_line_count(self) -> None:
        """唯一来源的判据：序号 == 文件行号。"""
        for index in range(5):
            self.ledger.append(self.thread["thread_id"], "message", {"i": index})
        lines = [ln for ln in self.trace.read_text(encoding="utf-8").splitlines()
                 if ln.strip()]
        self.assertEqual(len(lines), 5)
        self.assertEqual(
            self.store.get_thread(self.thread["thread_id"])["last_event_seq"],
            len(lines))

    def test_resume_after_returns_stored_seq(self) -> None:
        self.ledger.append(self.thread["thread_id"], "message", {"i": 0})
        self.ledger.append(self.thread["thread_id"], "message", {"i": 1})
        self.assertEqual(self.ledger.resume_after(self.thread["thread_id"]), 2)

    def test_resume_after_prefers_file_when_trace_is_truncated(self) -> None:
        """文件被截断过：以文件为准，并纠正缓存。

        静默沿用旧值会让续跑从第 5 条往后接，而文件里只剩 1 条 ——
        中间那几条事件就永远丢了。
        """
        tid = self.thread["thread_id"]
        for index in range(3):
            self.ledger.append(tid, "message", {"i": index})
        self.assertEqual(self.store.get_thread(tid)["last_event_seq"], 3)

        # 人为截断：只留第一行
        first = self.trace.read_text(encoding="utf-8").splitlines()[0]
        self.trace.write_text(first + "\n", encoding="utf-8", newline="\n")

        self.assertEqual(self.ledger.resume_after(tid), 1,
                         "文件被截断后应以文件行数为准")
        self.assertEqual(self.store.get_thread(tid)["last_event_seq"], 1,
                         "顺手要把缓存纠正过来，不能留一个偏大的值")

    def test_sync_is_idempotent(self) -> None:
        tid = self.thread["thread_id"]
        self.ledger.append(tid, "message", {"i": 0})
        self.assertEqual(self.ledger.sync(tid), 1)
        self.assertEqual(self.ledger.sync(tid), 1)


class TestCheckpointStillWorks(LedgerTestBase):
    """自建的节点检查点没被拆掉（它负责"跳过已完成节点"，原生 checkpointer 不管这事）。"""

    def test_record_and_resume(self) -> None:
        path = self.dir / "nodes.jsonl"
        store = CheckpointStore(path, clock=lambda: "2026-11-08T00:00:00+00:00")
        store.record("th-1", "qc", input_digest="a" * 16, output_digest="b" * 16)
        store.record("th-1", "device_monitor",
                     input_digest="c" * 16, output_digest="d" * 16)
        self.assertEqual(store.resume("th-1"), frozenset({"qc", "device_monitor"}))
        self.assertEqual(store.threads(), ["th-1"])

    def test_last_record_wins_for_same_node(self) -> None:
        path = self.dir / "nodes.jsonl"
        store = CheckpointStore(path, clock=lambda: "2026-11-08T00:00:00+00:00")
        store.record("th-1", "qc", input_digest="a" * 16, output_digest="b" * 16)
        store.record("th-1", "qc", input_digest="e" * 16, output_digest="f" * 16)
        done = store.completed("th-1")
        self.assertEqual(done["qc"]["output_digest"], "f" * 16)


class TestThreadRegistration(unittest.TestCase):
    """编排层要把线程落到 thread 表，且 thread_id 就是 task_id。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.store = BotStore(self.dir / "botd.sqlite")

    def tearDown(self) -> None:
        from fieldstation.botd import orchestrator as mod
        if mod.active() is not None:
            mod.active().shutdown()
        self._tmp.cleanup()

    def test_attach_thread_is_idempotent_and_uses_task_id(self) -> None:
        from fieldstation.botd.orchestrator import Orchestrator

        task = self.store.create_task(kind="bot", title="t", now=NOW)
        orch = Orchestrator(self.store, app_name="thread-test", executor=None)
        first = orch.attach_thread(task["task_id"], now=NOW)
        second = orch.attach_thread(task["task_id"], now=NOW)
        self.assertEqual(first["thread_id"], task["task_id"],
                         "thread_id 必须等于 task_id，否则两本账对不上")
        self.assertEqual(first["thread_id"], second["thread_id"])
        # 只插了一行
        self.assertEqual(len(self.store.list_threads()), 1)
        # run_link 也建立了
        links = self.store.list_run_links(task_id=task["task_id"], kind="thread")
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["external_id"], task["task_id"])

    def test_orchestrator_registers_thread_when_running(self) -> None:
        from fieldstation.botd.orchestrator import Orchestrator

        task = self.store.create_task(kind="bot", title="t", now=NOW)
        orch = Orchestrator(self.store, app_name="thread-test2",
                           executor=lambda t: {"ok": True})
        orch.launch()
        try:
            orch.run_task(task["task_id"])
        finally:
            orch.shutdown()
        rows = self.store.list_threads()
        self.assertEqual([r["thread_id"] for r in rows], [task["task_id"]])
        self.assertTrue(rows[0]["trace_path"].endswith(".jsonl"))

    def test_crashed_task_still_has_a_thread_row(self) -> None:
        """崩在中间也要留一条 thread 行 —— 否则查库没有任何线索。"""
        from fieldstation.botd.orchestrator import Orchestrator

        task = self.store.create_task(kind="bot", title="t", now=NOW)

        def boom(_task: dict):
            raise RuntimeError("中途炸了")

        orch = Orchestrator(self.store, app_name="thread-test3", executor=boom)
        orch.launch()
        try:
            with self.assertRaises(RuntimeError):
                orch.run_task(task["task_id"])
        finally:
            orch.shutdown()
        rows = self.store.list_threads()
        self.assertEqual(len(rows), 1, "崩了也要有 thread 行")
        self.assertEqual(rows[0]["thread_id"], task["task_id"])


class TestResumeDoesNotDuplicateMessages(unittest.TestCase):
    """计划书那句验收：「中断后按 last_event_seq + 1 续跑，不重复发消息」。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_resume_continues_from_next_line_without_duplicates(self) -> None:
        store = BotStore(self.dir / "botd.sqlite")
        trace = self.dir / "trace" / "run.jsonl"
        thread = store.create_thread(
            runtime="claude", external_thread_id="ext",
            checkpointer_ns="lg", trace_path=str(trace))
        ledger = TraceLedger(store, trace)
        tid = thread["thread_id"]

        # 第一段：真实的 MessageBus 上发 3 条消息，逐条记进 trace
        bus = MessageBus()
        for topic in ("a", "b", "c"):
            bus.publish(topic, sender="intake", payload={"v": topic})
        for message in bus.messages:
            ledger.append(tid, "message", {"topic": message.topic})

        seq_before = ledger.resume_after(tid)
        self.assertEqual(seq_before, 3)
        before_count = ledger.line_count()

        # "中断"之后续跑：只发**新增**的消息，从 last_event_seq+1 往后记
        remaining = ["d", "e"]
        for topic in remaining:
            bus.publish(topic, sender="qc", payload={"v": topic})
        for message in bus.messages[seq_before:]:
            ledger.append(tid, "message", {"topic": message.topic})

        after_count = ledger.line_count()
        # 断言：新增条数 == 真正新发的条数，没有把旧的再写一遍
        self.assertEqual(after_count - before_count, len(remaining),
                         "续跑把已经记过的消息又写了一遍")
        self.assertEqual(ledger.resume_after(tid), after_count)


if __name__ == "__main__":
    unittest.main()
