#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`botd/executors.py` 的行为覆盖：把记忆接上 Supervisor 的那一层。

## 为什么要单独测这一层

`Supervisor` 的 `StepSpec.tools` 是白名单**字符串**，执行器是注入的。于是
"记忆有没有真的接上"这件事，既不在 `memory.py` 的测试里（那只测门面），
也不在 `test_botd_supervisor.py` 里（那只测拆步与队列）。中间这层没人测，
就会变成"三个模块各自都对，组合起来参数永远是空的"。

## 要钉住的四件事

1. **payload 在子任务上，工具在 step 上** —— 在 step 表上找 payload 会永远拿到空 dict，
   而"参数为空"在 `memory.recall` 里表现为召回为空，是个静默的错误。
2. **`memory_missing` 不等于失败** —— EV-13 要求记忆不可用时任务照跑并标出来。
3. **`ok` 不是随便写的** —— 记忆降级时仍然 `ok: True`，否则 Supervisor 会判失败，
   与降级梯度的意思相反。
4. **拼错工具名要炸** —— 静默返回 `{"ok": True}` 会让一个没执行的动作记成成功。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.botd.executors import MemoryExecutor
from fieldstation.botd.memory import BotMemory
from fieldstation.botd.store import BotStore
from fieldstation.botd.supervisor import StepSpec, Supervisor


class BrokenBackend:
    """可用但调用必失败：模拟"服务起过又挂了"。"""

    name = "broken"

    def available(self) -> bool:
        return True

    def remember(self, bot_id: str, content: str, **kwargs):
        raise RuntimeError("connection refused")

    def recall(self, bot_id: str, query: str, limit: int = 5):
        raise RuntimeError("connection refused")


class FakeBackend:
    name = "fake"

    def __init__(self) -> None:
        self.written: list[dict] = []

    def available(self) -> bool:
        return True

    def remember(self, bot_id: str, content: str, **kwargs):
        self.written.append({"bot_id": bot_id, "content": content, **kwargs})
        return "ext-1"

    def recall(self, bot_id: str, query: str, limit: int = 5):
        return [{"id": "p1", "content": "向量命中", "key": "", "tags": [], "score": 0.9}]


class FixedPlanner:
    """按固定步骤表作答的规划器（`Supervisor` 要的是对象，不是函数）。"""

    def __init__(self, specs) -> None:
        self._specs = list(specs)

    def plan(self, task):
        return list(self._specs)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = BotStore(Path(self._tmp.name) / "botd.sqlite3")

    def memory(self, backend=None) -> BotMemory:
        return BotMemory(self.store, backend=backend)


class DirectCalls(Base):
    def test_recall_marks_memory_missing_when_empty(self) -> None:
        """全新 bot 召回为空 → 要标 memory_missing，但不许判失败。"""
        ex = MemoryExecutor(self.memory())
        result = ex("memory.recall", {"bot_id": "bot1", "query": "任意"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["memory_missing"])
        self.assertEqual(result["count"], 0)

    def test_recall_not_missing_when_rows_exist(self) -> None:
        memory = self.memory()
        memory.remember("bot1", "电池电压过低会告警")
        ex = MemoryExecutor(memory)
        result = ex("memory.recall", {"bot_id": "bot1", "query": "电池"})
        self.assertTrue(result["ok"])
        self.assertFalse(result["memory_missing"])
        self.assertGreaterEqual(result["count"], 1)

    def test_degraded_backend_marks_missing_but_stays_ok(self) -> None:
        """降级不是失败 —— 这是 EV-13 的原话。"""
        memory = self.memory(BrokenBackend())
        memory.remember("bot1", "先写一条（会降级）")
        ex = MemoryExecutor(memory)
        result = ex("memory.recall", {"bot_id": "bot1", "query": "写"})
        self.assertTrue(result["ok"], "记忆挂了不能让任务判失败")
        self.assertTrue(result["memory_missing"])
        self.assertTrue(result["degraded"])
        self.assertIn("connection refused", result["reason"])

    def test_remember_returns_external_id_when_backend_works(self) -> None:
        backend = FakeBackend()
        ex = MemoryExecutor(self.memory(backend))
        result = ex("memory.remember", {"bot_id": "bot1", "content": "内容", "key": "k1"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["backend"], "fake")
        self.assertEqual(result["external_id"], "ext-1")
        self.assertFalse(result["memory_missing"])
        self.assertEqual(backend.written[0]["content"], "内容")

    def test_remember_degrades_but_stays_ok(self) -> None:
        memory = self.memory(BrokenBackend())
        ex = MemoryExecutor(memory)
        result = ex("memory.remember", {"bot_id": "bot1", "content": "写不进去"})
        self.assertTrue(result["ok"], "外部写入失败不许把任务判失败")
        self.assertTrue(result["memory_missing"])
        self.assertEqual(result["backend"], "local-fallback")

    def test_unknown_tool_raises(self) -> None:
        ex = MemoryExecutor(self.memory())
        with self.assertRaises(KeyError):
            ex("memory.forget_everything", {"bot_id": "bot1"})

    def test_empty_bot_id_rejected(self) -> None:
        ex = MemoryExecutor(self.memory())
        with self.assertRaises(ValueError):
            ex("memory.recall", {"bot_id": "  ", "query": "x"})
        with self.assertRaises(ValueError):
            ex("memory.remember", {"bot_id": "bot1", "content": "   "})


class ThroughSupervisor(Base):
    """真正走 `Supervisor.run(executor=...)`：这一步才能发现"参数拿不到"。"""

    def test_payload_comes_from_child_task_not_from_step(self) -> None:
        """`payload` 在 task 表上，`tools` 在 step 表上。找错表会永远拿到空 dict。"""
        memory = self.memory()
        memory.remember("bot1", "历史记忆：低电压会丢星")

        captured: list[dict] = []
        ex = MemoryExecutor(memory)

        def executor(child: dict):
            result = ex.as_executor()(child)
            captured.append({"child_payload": child.get("payload"), "result": result})
            return result

        planner = FixedPlanner([StepSpec(name="召回记忆", tools=("memory.recall",), acceptance="拿到历史记忆")])
        sup = Supervisor(self.store, planner=planner)
        run = sup.run(
            {"kind": "data_qc", "bot_id": "bot1",
             "payload": {"query": "低电压"}},
            executor=executor,
        )
        self.assertEqual(run.status, "done", run)
        self.assertEqual(len(captured), 1)
        # 子任务 payload 的真实形状：父 payload 被包在 `task` 键下
        # （supervisor.py 里 `"payload": {"task": dict(payload), ...}`）。
        # 这条断言是给后来人看的：参数不在顶层，摊平那一层是执行器的责任。
        self.assertEqual(captured[0]["child_payload"]["task"]["query"], "低电压")
        # 而且真的召回到了东西（参数没丢）
        self.assertGreaterEqual(captured[0]["result"]["count"], 1,
                                f"召回为空说明 payload 丢了：{captured[0]}")

    def test_memory_step_succeeds_even_when_backend_broken(self) -> None:
        """端到端：记忆服务挂了，任务仍然 done 并标 memory_missing。"""
        memory = self.memory(BrokenBackend())
        ex = MemoryExecutor(memory).as_executor()
        planner = FixedPlanner([StepSpec(name="召回记忆", tools=("memory.recall",))])
        sup = Supervisor(self.store, planner=planner)
        run = sup.run({"kind": "data_qc", "bot_id": "bot1", "payload": {"query": "x"}},
                      executor=ex)
        self.assertEqual(run.status, "done")

        steps = self.store.list_steps(run.task_id)
        self.assertEqual(steps[0]["status"], "done")
        output = steps[0]["output"] or {}
        self.assertTrue(output.get("memory_missing"))
        self.assertTrue(output.get("ok"))

    def test_step_without_memory_tool_falls_through_to_fallback(self) -> None:
        ex = MemoryExecutor(self.memory())
        calls: list[str] = []

        def fallback(child):
            calls.append(child.get("step_id") or "")
            return {"ok": True, "note": "非记忆步骤"}

        executor = ex.as_executor(fallback=fallback)
        planner = FixedPlanner([StepSpec(name="别的活", tools=("data.read",))])
        sup = Supervisor(self.store, planner=planner)
        run = sup.run({"kind": "data_qc", "bot_id": "bot1"}, executor=executor)
        self.assertEqual(run.status, "done")
        self.assertEqual(len(calls), 1, "没给 fallback 就该被调用")

    def test_step_without_memory_tool_and_no_fallback_fails_loudly(self) -> None:
        ex = MemoryExecutor(self.memory()).as_executor()
        planner = FixedPlanner([StepSpec(name="别的活", tools=("data.read",))])
        sup = Supervisor(self.store, planner=planner, max_attempts=1, retry_delay=0)
        run = sup.run({"kind": "data_qc", "bot_id": "bot1"}, executor=ex)
        self.assertNotEqual(run.status, "done", "没有 fallback 时不许假装成功")


if __name__ == "__main__":
    unittest.main()
