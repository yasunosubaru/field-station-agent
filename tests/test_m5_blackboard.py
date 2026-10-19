"""M5-2：共享黑板的并发语义与受控访问（issue #61）。

四组测试，各自钉住一类性质：

* ``TestBoardStore`` —— 数据形状、CAS 写、深拷贝隔离、变更事件顺序；
* ``TestBoardScopes`` —— 视图范围（前缀语义、越权、快照过滤）；
* ``TestBoardConcurrency`` —— **真线程**：可见性（不会读到半个写）、create 竞争、
  CAS 竞争、并发读计数；
* ``TestChainIntegration`` —— 黑板接进 ``Pipeline`` 后：声明 → 视图 → 工具注入、
  跨阶段可见、越权在 trace 里留痕、不声明就没有工具、换一块板互不可见
  （「agent 之间不存在绕过黑板的隐藏状态」）。

并发测试不用 ``sleep`` 等时间窗口：用 ``threading.Barrier`` 把线程卡在同一起跑线，
用 ``Event`` 收尾，断言的是「结果只可能是一个赢家 / 读到的值自洽」，不是时序。
"""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path

from fieldstation.agents.blackboard import (
    Blackboard,
    BoardConflict,
    BoardPermissionError,
)
from fieldstation.agents.bus import MessageBus
from fieldstation.agents.pipeline import Pipeline, PipelineStage
from fieldstation.agents.providers.base import ChatResponse
from fieldstation.agents.providers.fake import FakeProvider
from fieldstation.agents.runtime import Agent
from fieldstation.agents.tools import ToolRegistry, ToolResult
from fieldstation.agents.tools.board_tools import BoardReadTool
from fieldstation.agents.trace.writer import TraceWriter


class _EchoTool:
    name = "echo"
    description = "回显参数（测试替身）"
    params = {"value": "任意值"}
    risk = "low"

    def invoke(self, args):
        return ToolResult(ok=True, data={"echo": args.get("value")})


def _tool_call(name: str, args: dict) -> dict:
    return {"name": name, "args": args, "reason": "测试", "confidence": 0.9}


def _conclusion(evidence) -> str:
    return json.dumps({
        "attribution": {
            "fault_type": "测试结论",
            "evidence": [{"call_id": c, "tool": t, "finding": f"证据 {c}"}
                         for c, t in evidence],
        },
        "recommendation": "按规程处理",
        "confidence": 0.9,
    }, ensure_ascii=False, sort_keys=True)


def _stage(name, topic, consumes, responses, tools, *,
           board_reads=(), board_writes=()):
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    agent = Agent(name=name, system_prompt=f"你是 {name} 助手",
                  provider=FakeProvider(list(responses)),
                  tools=registry.describe())
    return PipelineStage(name=name, agent=agent, registry=registry, topic=topic,
                         consumes=tuple(consumes),
                         board_reads=tuple(board_reads),
                         board_writes=tuple(board_writes))


class TestBoardStore(unittest.TestCase):
    def setUp(self):
        self.board = Blackboard()

    def test_key_shape_enforced(self):
        for bad in ("", "station", "other/X", "station/", "/X", "station//x", 42):
            with self.assertRaises(ValueError, msg=repr(bad)):
                self.board.create(bad, {"v": 1})

    def test_value_must_be_json_dict(self):
        for bad in ([], {"x": float("nan")}, {"x": object()}, "str", 3):
            with self.assertRaises(ValueError, msg=repr(bad)):
                self.board.create("station/BADG", bad)

    def test_create_read_and_version(self):
        entry = self.board.create("station/BADG", {"status": "ok"}, by="qc")
        self.assertEqual((entry.version, entry.by), (1, "qc"))
        got = self.board.read("station/BADG")
        self.assertEqual(got.value, {"status": "ok"})
        self.assertEqual(got.version, 1)

    def test_create_duplicate_conflicts(self):
        self.board.create("station/BADG", {"v": 1})
        with self.assertRaises(BoardConflict):
            self.board.create("station/BADG", {"v": 2})

    def test_update_is_cas(self):
        self.board.create("station/BADG", {"v": 1})
        entry = self.board.update("station/BADG", {"v": 2}, expect_version=1,
                                  by="monitor")
        self.assertEqual((entry.version, entry.by), (2, "monitor"))
        with self.assertRaises(BoardConflict) as ctx:
            self.board.update("station/BADG", {"v": 3}, expect_version=1)
        self.assertEqual(ctx.exception.actual, 2)

    def test_update_or_delete_missing_conflicts(self):
        with self.assertRaises(BoardConflict):
            self.board.update("alert/A-1", {"v": 1}, expect_version=1)
        with self.assertRaises(BoardConflict):
            self.board.delete("alert/A-1", expect_version=1)

    def test_upsert_creates_then_bumps_version(self):
        self.assertEqual(self.board.upsert("order/WO-1", {"s": "open"}).version, 1)
        self.assertEqual(self.board.upsert("order/WO-1", {"s": "done"}).version, 2)

    def test_delete_returns_entry_and_removes_key(self):
        self.board.create("alert/A-1", {"v": 1})
        gone = self.board.delete("alert/A-1", expect_version=1)
        self.assertEqual(gone.version, 1)
        self.assertIsNone(self.board.read("alert/A-1"))

    def test_values_are_deep_copied(self):
        value = {"nested": {"n": 1}}
        self.board.create("station/BADG", value)
        value["nested"]["n"] = 99
        self.assertEqual(self.board.read("station/BADG").value["nested"]["n"], 1)
        got = self.board.read("station/BADG")
        got.value["nested"]["n"] = 7
        self.assertEqual(self.board.read("station/BADG").value["nested"]["n"], 1)

    def test_snapshot_and_keys_sorted_and_independent(self):
        self.board.create("station/BADG", {"v": 1})
        self.board.create("alert/A-1", {"v": 1})
        self.assertEqual(self.board.keys(), ("alert/A-1", "station/BADG"))
        snap = self.board.snapshot()
        snap["station/BADG"].value["v"] = 99
        self.assertEqual(self.board.read("station/BADG").value["v"], 1)
        self.assertEqual(list(self.board.snapshot("station")), ["station/BADG"])

    def test_events_in_commit_order_and_reads_silent(self):
        events: list[dict] = []
        board = Blackboard(on_event=events.append)
        board.create("station/BADG", {"v": 1}, by="a")
        board.read("station/BADG")
        board.update("station/BADG", {"v": 2}, expect_version=1, by="b")
        board.upsert("alert/A-1", {"v": 1}, by="c")
        board.delete("alert/A-1", expect_version=1, by="d")
        self.assertEqual([e["op"] for e in events],
                         ["create", "update", "upsert", "delete"])
        self.assertEqual([e["version"] for e in events], [1, 2, 1, 1])
        self.assertEqual([e["by"] for e in events], ["a", "b", "c", "d"])


class TestBoardScopes(unittest.TestCase):
    def setUp(self):
        self.board = Blackboard()
        self.board.create("station/BADG", {"health": "ok"})
        self.board.create("alert/A-1", {"level": "warn"})
        self.board.create("order/WO-1", {"status": "open"})

    def test_read_scope_blocks_other_namespaces(self):
        view = self.board.scope(reads=("station",), actor="qc")
        self.assertIsNotNone(view.read("station/BADG"))
        with self.assertRaises(BoardPermissionError):
            view.read("alert/A-1")

    def test_prefix_matching_is_segment_aware(self):
        self.board.create("station/BADGX", {"health": "ok"})
        view = self.board.scope(reads=("station/BADG",))
        self.assertIsNotNone(view.read("station/BADG"))
        with self.assertRaises(BoardPermissionError):
            view.read("station/BADGX")

    def test_write_scope_and_actor(self):
        view = self.board.scope(reads=("order",), writes=("order",),
                                actor="dispatch")
        entry = view.create("order/WO-2", {"status": "open"})
        self.assertEqual(entry.by, "dispatch")
        with self.assertRaises(BoardPermissionError):
            view.create("station/BADG", {"health": "fake"})

    def test_snapshot_filters_to_read_scope(self):
        view = self.board.scope(reads=("station", "alert"))
        self.assertEqual(list(view.snapshot()), ["alert/A-1", "station/BADG"])
        self.assertEqual(view.keys(), ("alert/A-1", "station/BADG"))
        # 前缀落在范围外 → 空，而不是报错（读不到就是读不到）
        self.assertEqual(view.snapshot("order"), {})

    def test_wildcard_scope_sees_everything(self):
        view = self.board.scope(reads=("*",), writes=("*",), actor="dashboard")
        self.assertEqual(len(view.snapshot()), 3)
        self.assertEqual(view.upsert("order/WO-9", {"status": "open"}).by,
                         "dashboard")


class TestBoardConcurrency(unittest.TestCase):
    def test_concurrent_create_has_exactly_one_winner(self):
        board = Blackboard()
        workers = 8
        barrier = threading.Barrier(workers)
        lock = threading.Lock()
        outcomes: list[str] = []

        def worker(i: int) -> None:
            barrier.wait()
            try:
                board.create("station/BADG", {"thread": i})
                outcome = "ok"
            except BoardConflict:
                outcome = "conflict"
            with lock:
                outcomes.append(outcome)

        threads = [threading.Thread(target=worker, args=(i,))
                   for i in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive(), "create 竞争测试超时")
        self.assertEqual(outcomes.count("ok"), 1)
        self.assertEqual(outcomes.count("conflict"), workers - 1)
        self.assertEqual(board.read("station/BADG").version, 1)

    def test_concurrent_cas_update_has_exactly_one_winner(self):
        board = Blackboard()
        board.create("order/WO-1", {"status": "open"})
        workers = 8
        barrier = threading.Barrier(workers)
        lock = threading.Lock()
        outcomes: list[str] = []

        def worker(i: int) -> None:
            barrier.wait()
            try:
                board.update("order/WO-1", {"status": f"w{i}"},
                             expect_version=1)
                outcome = "ok"
            except BoardConflict:
                outcome = "conflict"
            with lock:
                outcomes.append(outcome)

        threads = [threading.Thread(target=worker, args=(i,))
                   for i in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive(), "CAS 竞争测试超时")
        self.assertEqual(outcomes.count("ok"), 1)
        self.assertEqual(outcomes.count("conflict"), workers - 1)
        self.assertEqual(board.read("order/WO-1").version, 2)

    def test_readers_never_see_torn_values(self):
        board = Blackboard()
        board.create("station/BADG", {"n": 0, "double": 0})
        stop = threading.Event()
        reads = [0, 0, 0]
        failures: list[dict] = []

        def reader(i: int) -> None:
            while not stop.is_set():
                entry = board.read("station/BADG")
                reads[i] += 1
                if entry.value["double"] != entry.value["n"] * 2:
                    failures.append(entry.value)

        threads = [threading.Thread(target=reader, args=(i,))
                   for i in range(len(reads))]
        for thread in threads:
            thread.start()
        for i in range(1, 401):
            board.upsert("station/BADG", {"n": i, "double": i * 2})
        stop.set()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive(), "可见性测试超时")
        self.assertEqual(failures, [])
        self.assertTrue(all(count > 0 for count in reads), reads)
        self.assertEqual(board.read("station/BADG").value["n"], 400)


class TestChainIntegration(unittest.TestCase):
    def _pipeline(self, board, stages):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        trace_path = Path(td.name) / "trace.jsonl"
        bus = MessageBus(TraceWriter(trace_path))
        return Pipeline(bus, trace_path, stages, board=board), trace_path

    def _three_stage_chain(self):
        collector = _stage("collector", "data.collected", (), [
            ChatResponse(content="", tool_calls=[_tool_call(
                "board_write", {"key": "station/BADG",
                                "value": {"status": "degraded",
                                          "health_score": 0.667},
                                "must_not_exist": True})]),
            ChatResponse(content=_conclusion([("t0001", "board_write")])),
        ], [], board_writes=("station",))
        monitor = _stage("monitor", "device.health", ("data.collected",), [
            ChatResponse(content="", tool_calls=[_tool_call(
                "board_read", {"key": "station/BADG"})]),
            ChatResponse(content="", tool_calls=[_tool_call(
                "board_write", {"key": "alert/A-0001",
                                "value": {"station": "BADG",
                                          "level": "warn"}})]),
            ChatResponse(content=_conclusion([("t0001", "board_read"),
                                              ("t0002", "board_write")])),
        ], [], board_reads=("station",), board_writes=("alert",))
        auditor = _stage("auditor", "audit.done", ("device.health",), [
            ChatResponse(content="", tool_calls=[_tool_call(
                "board_write", {"key": "station/BADG",
                                "value": {"forged": True}})]),
            ChatResponse(content="", tool_calls=[_tool_call(
                "echo", {"value": "audited"})]),
            ChatResponse(content=_conclusion([("t0002", "echo")])),
        ], [_EchoTool()], board_writes=("order",))
        return [collector, monitor, auditor]

    def test_cross_stage_visibility_and_permission_in_trace(self):
        board = Blackboard()
        pipeline, trace_path = self._pipeline(board, self._three_stage_chain())
        result = pipeline.run(intake=[("data.raw", {"note": "batch"})])
        self.assertEqual(len(result.messages), 4)  # 1 条 intake + 3 个阶段
        self.assertEqual([m.topic for m in result.messages],
                         ["data.raw", "data.collected", "device.health",
                          "audit.done"])

        station = board.read("station/BADG")
        self.assertEqual(station.value["health_score"], 0.667)
        self.assertEqual(station.by, "collector")
        self.assertEqual(board.read("alert/A-0001").by, "monitor")

        events = [json.loads(line) for line in
                  trace_path.read_text(encoding="utf-8").splitlines()]
        monitor_reads = [e for e in events
                         if e.get("kind") == "tool_result"
                         and e.get("agent") == "monitor"
                         and e.get("tool") == "board_read"]
        self.assertEqual(len(monitor_reads), 1)
        self.assertTrue(monitor_reads[0]["ok"])
        # 跨阶段可见：monitor 读到的就是 collector 写进去的值
        self.assertEqual(monitor_reads[0]["result"]["value"]["status"],
                         "degraded")

        forbidden = [e for e in events
                     if e.get("kind") == "tool_result"
                     and e.get("agent") == "auditor"
                     and e.get("tool") == "board_write"]
        self.assertEqual(len(forbidden), 1)
        self.assertFalse(forbidden[0]["ok"])
        self.assertIn("超出视图范围", forbidden[0]["error"])
        # 越权写没有改动黑板
        self.assertNotIn("forged", board.read("station/BADG").value)

    def test_declaration_controls_tool_injection(self):
        board = Blackboard()
        read_only = _stage("ro", "t.ro", (), [], [], board_reads=("station",))
        write_only = _stage("wo", "t.wo", (), [], [], board_writes=("order",))
        plain = _stage("plain", "t.plain", (), [], [])
        pipeline, _ = self._pipeline(board, [read_only, write_only, plain])

        _, ro_registry = pipeline.wired("ro")
        self.assertIn("board_read", ro_registry.names())
        self.assertNotIn("board_write", ro_registry.names())
        _, wo_registry = pipeline.wired("wo")
        self.assertIn("board_write", wo_registry.names())
        self.assertNotIn("board_read", wo_registry.names())
        _, plain_registry = pipeline.wired("plain")
        self.assertEqual(plain_registry.names(), ())
        ro_agent, _ = pipeline.wired("ro")
        self.assertIn("board_read", [tool["name"] for tool in ro_agent.tools])

    def test_declared_scope_without_board_rejected(self):
        stage = _stage("ro", "t.ro", (), [], [], board_reads=("station",))
        with tempfile.TemporaryDirectory() as td:
            trace_path = Path(td) / "trace.jsonl"
            bus = MessageBus(TraceWriter(trace_path))
            with self.assertRaises(ValueError):
                Pipeline(bus, trace_path, [stage])

    def test_duplicate_board_tool_wiring_rejected(self):
        board = Blackboard()
        stage = _stage("ro", "t.ro", (), [], [], board_reads=("station",))
        stage.registry.register(BoardReadTool(board.scope(reads=("station",))))
        with tempfile.TemporaryDirectory() as td:
            trace_path = Path(td) / "trace.jsonl"
            bus = MessageBus(TraceWriter(trace_path))
            with self.assertRaises(ValueError):
                Pipeline(bus, trace_path, [stage], board=board)

    def test_fresh_board_means_no_hidden_state(self):
        """换一块板就什么都看不到：上下文只存在于黑板，不在模块/进程全局里。"""
        first = Blackboard()
        pipeline, _ = self._pipeline(first, self._three_stage_chain())
        pipeline.run(intake=[("data.raw", {"note": "batch"})])
        self.assertEqual(first.keys(), ("alert/A-0001", "station/BADG"))

        second = Blackboard()
        self.assertEqual(second.keys(), ())
        pipeline2, _ = self._pipeline(second, self._three_stage_chain())
        pipeline2.run(intake=[("data.raw", {"note": "batch"})])
        self.assertEqual(second.keys(), ("alert/A-0001", "station/BADG"))
        self.assertEqual(second.read("station/BADG").value,
                         first.read("station/BADG").value)


if __name__ == "__main__":
    unittest.main()
