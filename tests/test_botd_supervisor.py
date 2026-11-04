"""E2 botd 监督者：固定拆步、子步入队、失败重试与汇总。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Mapping

from fieldstation.botd.queue import TaskQueue
from fieldstation.botd.store import BotStore
from fieldstation.botd.supervisor import (
    DEFAULT_PLANS,
    RulePlanner,
    StepSpec,
    Supervisor,
    SupervisorError,
)

NOW = datetime(2026, 11, 5, 8, 0, 0, tzinfo=timezone.utc)


class SupervisorTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db = Path(self._tmp.name) / "botd.sqlite3"
        self.store = BotStore(self.db)
        self.queue = TaskQueue(self.store, backoff_base=1.0)
        self.supervisor = Supervisor(
            self.store,
            queue=self.queue,
            retry_delay=0.0,
            max_attempts=2,
        )


class TestRulePlanner(unittest.TestCase):
    def test_data_qc_has_ordered_steps_with_tools_and_acceptance(self) -> None:
        steps = RulePlanner().plan({"kind": "data_qc"})
        self.assertEqual(len(steps), 3)
        self.assertEqual(
            [step.name for step in steps],
            ["读取观测数据", "质量检查", "生成 QC 报告"],
        )
        for step in steps:
            self.assertIsInstance(step, StepSpec)
            self.assertTrue(step.tools, f"步骤 {step.name} 没有工具白名单")
            self.assertTrue(step.acceptance, f"步骤 {step.name} 没有验收条件")
            self.assertTrue(step.kind)

    def test_unknown_kind_falls_back_to_generic(self) -> None:
        planner = RulePlanner()
        steps = planner.plan({"kind": "从来没有定义过的类型"})
        self.assertTrue(planner.last_fallback)
        self.assertEqual(
            [step.name for step in steps],
            [step.name for step in DEFAULT_PLANS["generic"]],
        )

    def test_missing_generic_plan_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            RulePlanner({"data_qc": DEFAULT_PLANS["data_qc"]})


class TestSupervisorRun(SupervisorTestBase):
    def test_without_executor_enqueues_all_steps(self) -> None:
        result = self.supervisor.run(
            {"kind": "data_qc", "payload": {"station": "S01"}}, now=NOW
        )
        self.assertEqual(result.status, "running")
        self.assertEqual(len(result.plan), 3)
        self.assertEqual(len(result.children), 3)
        self.assertEqual({child["status"] for child in result.children}, {"pending"})

        parent = self.store.get_task(result.task_id)
        self.assertEqual(parent["status"], "running")
        self.assertEqual(parent["payload"], {"station": "S01"})

        steps = self.store.list_steps(result.task_id)
        self.assertEqual([step["idx"] for step in steps], [0, 1, 2])
        self.assertEqual(len({step["task_ref"] for step in steps}), 3)
        self.assertEqual(steps[0]["tools"], ["data.read", "station.list"])
        self.assertTrue(steps[0]["acceptance"])
        for step in steps:
            self.assertEqual(step["status"], "pending")

    def test_executor_runs_steps_in_plan_order_and_aggregates(self) -> None:
        calls: List[str] = []

        def executor(task: dict) -> dict:
            calls.append(task["payload"]["step"])
            return {"ok": True, "step": task["payload"]["step"]}

        result = self.supervisor.run(
            {"kind": "station_health", "payload": {"station": "S02"}},
            executor=executor,
            now=NOW,
        )
        self.assertEqual(result.status, "done")
        self.assertEqual(result.attempts, 3)
        self.assertEqual(
            calls,
            ["采集站点状态", "核对告警阈值", "生成健康摘要"],
        )
        parent = self.store.get_task(result.task_id)
        self.assertEqual(parent["status"], "done")
        self.assertEqual(parent["result"]["status"], "done")

        steps = self.store.list_steps(result.task_id)
        self.assertEqual([step["status"] for step in steps], ["done", "done", "done"])
        self.assertEqual(steps[0]["output"]["step"], "采集站点状态")

    def test_transient_failure_is_retried_then_succeeds(self) -> None:
        calls: List[str] = []
        failures = {"质量检查": 1}

        def executor(task: dict) -> dict:
            step = task["payload"]["step"]
            calls.append(step)
            if failures.get(step, 0) > 0:
                failures[step] -= 1
                raise RuntimeError("第一次读数还没到")
            return {"ok": True}

        result = self.supervisor.run(
            {"kind": "data_qc", "payload": {"station": "S03"}},
            executor=executor,
            now=NOW,
        )
        self.assertEqual(result.status, "done")
        self.assertEqual(calls.count("质量检查"), 2)
        self.assertEqual(len(calls), 4)
        self.assertEqual(result.attempts, 4)

        retried = [
            child for child in result.children
            if child["kind"] == "qc.run"
        ][0]
        self.assertEqual(retried["status"], "done")
        self.assertEqual(retried["attempts"], 2)

    def test_exhausted_retries_mark_run_failed(self) -> None:
        def executor(task: dict) -> dict:
            return {"ok": False, "error": "阈值检查不通过"}

        result = self.supervisor.run(
            {"kind": "data_qc"}, executor=executor, now=NOW
        )
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error, "有子步重试用尽")
        self.assertEqual({child["status"] for child in result.children}, {"dead"})
        self.assertEqual({child["attempts"] for child in result.children}, {2})

        parent = self.store.get_task(result.task_id)
        self.assertEqual(parent["status"], "failed")
        self.assertEqual(parent["result"]["counts"], {"dead": 3})

    def test_executor_exception_message_is_preserved(self) -> None:
        def executor(task: dict) -> dict:
            raise ValueError("缺少站点编号")

        result = self.supervisor.run({"kind": "data_qc"}, executor=executor, now=NOW)
        self.assertEqual(result.status, "failed")
        self.assertTrue(all("缺少站点编号" in (child["last_error"] or "")
                            for child in result.children))

    def test_unknown_kind_uses_generic_plan(self) -> None:
        result = self.supervisor.run({"kind": "adhoc"}, now=NOW)
        self.assertEqual(
            [item["name"] for item in result.plan],
            ["准备上下文", "执行任务", "归档结果"],
        )
        self.assertEqual(len(result.children), 3)

    def test_invalid_task_and_empty_plan_are_rejected(self) -> None:
        with self.assertRaises(SupervisorError):
            self.supervisor.run({"kind": " "}, now=NOW)
        with self.assertRaises(SupervisorError):
            self.supervisor.run({"kind": "data_qc", "payload": "不是 mapping"}, now=NOW)

        class EmptyPlanner:
            def plan(self, task: Mapping) -> List[StepSpec]:
                return []

        supervisor = Supervisor(self.store, EmptyPlanner(), queue=self.queue)
        with self.assertRaises(SupervisorError):
            supervisor.run({"kind": "data_qc"}, now=NOW)

    def test_duplicate_step_names_are_rejected_before_queueing(self) -> None:
        class DuplicatePlanner:
            def plan(self, task: Mapping) -> List[StepSpec]:
                return [
                    StepSpec(name="重复", acceptance="随便"),
                    StepSpec(name="重复", acceptance="随便"),
                ]

        supervisor = Supervisor(self.store, DuplicatePlanner(), queue=self.queue)
        before = len(self.store.list_tasks())
        with self.assertRaises(SupervisorError):
            supervisor.run({"kind": "data_qc"}, now=NOW)
        self.assertEqual(len(self.store.list_tasks()), before)

    def test_daemon_executes_children_and_collect_finishes_parent(self) -> None:
        from fieldstation.botd.daemon import BotDaemon

        enqueued = self.supervisor.run({"kind": "data_qc"}, now=NOW)
        self.assertEqual(enqueued.status, "running")

        daemon = BotDaemon(
            self.store,
            queue=self.queue,
            clock=lambda: NOW,
            ttl=30.0,
        )
        self.assertEqual(daemon.tick()["action"], "ran")
        self.assertEqual(daemon.tick()["action"], "ran")
        self.assertEqual(daemon.tick()["action"], "ran")
        self.assertEqual(daemon.tick()["action"], "idle")
        self.assertEqual(
            [step["status"] for step in self.store.list_steps(enqueued.task_id)],
            ["done", "done", "done"],
        )

        collected = self.supervisor.collect(enqueued.task_id, now=NOW)
        self.assertEqual(collected.status, "done")
        self.assertEqual(self.store.get_task(enqueued.task_id)["status"], "done")


if __name__ == "__main__":
    unittest.main()
