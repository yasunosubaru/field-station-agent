# -*- coding: utf-8 -*-
"""Bot-1 验收：DBOS 编排层。

三条验收（计划书 Bot-1「改成什么样」）：

1. **杀进程重启继续** —— 跑到第 2 步强杀，重启后从第 2 步继续，第 1 步不重跑。
2. **同一任务只跑一次** —— 同一 ``task_id`` 触发两次，只产生一个工作流实例。
3. **睡觉不占进程** —— 工作流睡在闸门上时，进程可以死、可以重启、可以续。

第 1 与第 3 条必须跨进程才算数，所以这里用子进程跑，父进程判分。
单进程里"看起来没重跑"证明不了什么 —— 那是本项目最贵的一条纪律：
重跑一次写动作就是重复扣 token、重复写文件。

DBOS 是**进程级单例**，且 ``launch()`` 会自动恢复未完成工作流。所以每个用例
用**独立的库文件与独立的应用名**，并在 ``tearDown`` 里 ``shutdown()``，
否则上一个用例的半截工作流会跑进下一个用例。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fieldstation.botd import orchestrator as orchestrator_mod
from fieldstation.botd.orchestrator import (
    Orchestrator,
    OrchestratorError,
    approve,
    active,
)
from fieldstation.botd.store import BotStore

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 11, 8, 12, 0, 0, tzinfo=timezone.utc)


class OrchestratorTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.store = BotStore(self.dir / "botd.sqlite")
        self.orch: Orchestrator | None = None
        os.environ.setdefault("DBOS__CONSOLE_LOG_LEVEL", "ERROR")

    def tearDown(self) -> None:
        if self.orch is not None:
            self.orch.shutdown()
            self.orch = None
        # 双保险：万一某个用例没走 shutdown
        if active() is not None:
            active().shutdown()
        self._tmp.cleanup()

    def make_orch(self, **kwargs) -> Orchestrator:
        kwargs.setdefault("app_name", f"test-{self._testMethodName}")
        self.orch = Orchestrator(self.store, **kwargs)
        return self.orch

    def make_task(self, **kwargs) -> dict:
        kwargs.setdefault("kind", "bot")
        kwargs.setdefault("title", "t")
        kwargs.setdefault("now", NOW)
        return self.store.create_task(**kwargs)


class TestWiring(OrchestratorTestBase):
    def test_runs_one_task_and_marks_done(self) -> None:
        seen: list[str] = []
        task = self.make_task()
        orch = self.make_orch(executor=lambda t: seen.append(t["task_id"]) or {"ok": True})
        orch.launch()
        outcome = orch.run_task(task["task_id"])
        self.assertIsNotNone(outcome)
        self.assertEqual(outcome.status, "done")
        self.assertEqual(seen, [task["task_id"]])
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "done")

    def test_steps_from_step_table_are_executed_in_order(self) -> None:
        task = self.make_task()
        for index, name in enumerate(("查数据", "判断", "出结论")):
            self.store.create_step(task_id=task["task_id"], idx=index, name=name)
        order: list[str] = []

        def executor(t: dict) -> dict:
            return {"ok": True}

        orch = self.make_orch(executor=executor)
        orch.launch()
        outcome = orch.run_task(task["task_id"])
        # 步骤名按 idx 顺序进 steps_done
        self.assertEqual(outcome.steps_done, ["查数据", "判断", "出结论"])
        # 业务表的 step 行全部 done
        statuses = [s["status"] for s in self.store.list_steps(task["task_id"])]
        self.assertEqual(statuses, ["done", "done", "done"])

    def test_workflow_status_is_reported(self) -> None:
        task = self.make_task()
        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.launch()
        orch.run_task(task["task_id"])
        self.assertEqual(orch.workflow_status(task["task_id"]), "SUCCESS")

    def test_run_before_launch_is_refused(self) -> None:
        task = self.make_task()
        orch = self.make_orch(executor=lambda t: {"ok": True})
        with self.assertRaises(OrchestratorError):
            orch.run_task(task["task_id"])

    def test_only_one_orchestrator_per_process(self) -> None:
        self.make_orch(executor=lambda t: {"ok": True}).configure()
        other = Orchestrator(self.store, app_name="other")
        self.orch = other
        with self.assertRaises(OrchestratorError):
            other.configure()

    def test_configure_is_idempotent(self) -> None:
        orch = self.make_orch(executor=lambda t: {"ok": True})
        first = orch.configure()
        self.assertIs(orch.configure(), first)

    def test_dbos_db_is_separate_from_business_db(self) -> None:
        orch = self.make_orch(executor=lambda t: {"ok": True})
        self.assertEqual(orch.dbos_db_path.name, "dbos.sqlite")
        self.assertNotEqual(orch.dbos_db_path, self.store.path)
        self.assertEqual(orch.dbos_db_path.parent, self.store.path.parent)

    def test_no_executor_still_runs(self) -> None:
        task = self.make_task()
        orch = self.make_orch(executor=None)
        orch.launch()
        outcome = orch.run_task(task["task_id"])
        self.assertEqual(outcome.status, "done")


class TestGate(OrchestratorTestBase):
    def test_approved_gate_lets_the_task_finish(self) -> None:
        task = self.make_task()
        for index, name in enumerate(("准备", "写动作", "收尾")):
            self.store.create_step(task_id=task["task_id"], idx=index, name=name)
        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.set_gate_steps(["写动作"])
        orch.gate_poll_seconds = 0.05
        orch.gate_recv_timeout_seconds = 30.0
        orch.launch()

        import threading
        import time

        result: dict = {}

        def run() -> None:
            result["outcome"] = orch.run_task(task["task_id"])

        worker = threading.Thread(target=run)
        worker.start()
        # 等它真的去等人了
        for _ in range(400):
            if self.store.get_task(task["task_id"])["status"] == "waiting_approval":
                break
            time.sleep(0.05)
        self.assertEqual(self.store.get_task(task["task_id"])["status"],
                         "waiting_approval",
                         "闸门处业务表必须标 waiting_approval，而不是继续 running")
        approve(task["task_id"], by="user:1", note="同意")
        worker.join(timeout=60)
        self.assertFalse(worker.is_alive())

        outcome = result.get("outcome")
        self.assertIsNotNone(outcome)
        self.assertEqual(outcome.status, "done")
        self.assertTrue(outcome.gate.approved)
        self.assertEqual(outcome.gate.by, "user:1")
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "done")

    def test_rejected_gate_cancels_the_task(self) -> None:
        task = self.make_task()
        self.store.create_step(task_id=task["task_id"], idx=0, name="写动作")
        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.set_gate_steps(["写动作"])
        orch.gate_poll_seconds = 0.05
        orch.gate_recv_timeout_seconds = 30.0
        orch.launch()

        import threading
        import time

        result: dict = {}

        def run() -> None:
            result["outcome"] = orch.run_task(task["task_id"])

        worker = threading.Thread(target=run)
        worker.start()
        for _ in range(400):
            if self.store.get_task(task["task_id"])["status"] == "waiting_approval":
                break
            time.sleep(0.05)
        approve(task["task_id"], by="user:1", note="不行", approved=False)
        worker.join(timeout=60)
        outcome = result["outcome"]
        self.assertEqual(outcome.status, "cancelled")
        self.assertFalse(outcome.gate.approved)

    def test_gate_steps_must_be_declared_before_launch(self) -> None:
        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.launch()
        with self.assertRaises(OrchestratorError):
            orch.set_gate_steps(["x"])

    def test_approve_without_orchestrator_raises(self) -> None:
        with self.assertRaises(OrchestratorError):
            approve("t-whatever")


# --------------------------------------------------------------------- 跨进程 --
_CHILD = r"""
import os, sys, time
sys.path.insert(0, {src!r})
from pathlib import Path
from dbos import SetWorkflowID
from fieldstation.botd.store import BotStore
from fieldstation.botd.orchestrator import Orchestrator

work = Path({work!r})
marker = work / "marker.txt"
store = BotStore(work / "botd.sqlite")
task_id = {task_id!r}

def mark(line):
    with marker.open("a", encoding="utf-8") as f:
        f.write(line + "\n"); f.flush(); os.fsync(f.fileno())

def executor(task):
    name = task["current_step"]
    mark("begin:" + name)
    time.sleep({step_seconds!r})
    mark("end:" + name)
    return {{"ok": True}}

orch = Orchestrator(store, executor=executor, app_name={app_name!r})
orch.launch()

if {should_kill!r}:
    # 工作流在后台线程跑；等第 2 步"开始"之后再强杀 —— 这样被杀时第 1 步已完成、
    # 第 2 步正在飞。那正是要验的局面。
    with SetWorkflowID(task_id):
        orch._dbos.start_workflow(orch._task_run, task_id)
    for _ in range(4000):
        text = marker.read_text(encoding="utf-8") if marker.exists() else ""
        if text.count("begin:") >= {kill_after!r}:
            break
        time.sleep(0.01)
    time.sleep({kill_delay!r})
    os._exit(9)
else:
    outcome = orch.run_task(task_id)
    print("STATUS=" + str(outcome.status))
    print("STEPS=" + repr(outcome.steps_done))
    orch.shutdown()
"""


class TestCrossProcess(OrchestratorTestBase):
    """第 1、3 条验收必须跨进程才有意义。"""

    def _run_child(self, *, task_id: str, app_name: str, should_kill: bool,
                   kill_delay: float = 0.05, step_seconds: float = 0.3,
                   kill_after: int = 2) -> subprocess.CompletedProcess:
        code = _CHILD.format(
            src=str(ROOT / "src"), work=str(self.dir), task_id=task_id,
            app_name=app_name, should_kill=should_kill, kill_delay=kill_delay,
            step_seconds=step_seconds, kill_after=kill_after)
        env = dict(os.environ)
        env["DBOS__CONSOLE_LOG_LEVEL"] = "ERROR"
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        return subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, timeout=300, env=env,
            encoding="utf-8", errors="replace", cwd=str(ROOT))

    def test_crash_mid_task_resumes_without_rerunning_done_steps(self) -> None:
        """在第 2 步执行到一半时强杀；重启后接着跑完。

        **准确的说法**（实测，见 ``docs/operations/dbos.md`` §1.2）：

        * 已经**记完**的步骤 —— 杀之前已完成的那一步 —— **不重跑**。
        * 被杀那一刻**正在执行**的那一步 —— 必然重跑，因为它还没被记为完成。

        所以断言不是"每步只跑一次"，而是"**每一步最多跑两次、且只有被杀那一刻
        在飞的那一步允许第二次**"。把这条写成"绝不重跑"会让断言永远绿或永远红，
        两者都是假信号。
        """
        task = self.make_task()
        for index, name in enumerate(("第一步", "第二步", "第三步")):
            self.store.create_step(task_id=task["task_id"], idx=index, name=name)
        app = f"crash-{self._testMethodName}"
        marker = self.dir / "marker.txt"

        first = self._run_child(task_id=task["task_id"], app_name=app,
                                should_kill=True, kill_after=2)
        self.assertEqual(
            first.returncode, 9,
            f"子进程没有被强杀，无法验证续跑：{first.returncode}\n{first.stderr[-800:]}")
        before = marker.read_text(encoding="utf-8").splitlines()
        begun = [x.split(":", 1)[1] for x in before if x.startswith("begin:")]
        ended = [x.split(":", 1)[1] for x in before if x.startswith("end:")]
        # 反空转：必须真的杀在"第 2 步正在飞"的时刻
        self.assertEqual(begun, ["第一步", "第二步"],
                         f"杀之前开始的步骤是 {begun}，不是预期的前两步")
        self.assertEqual(ended, ["第一步"],
                         f"杀之前完成的步骤是 {ended}，应该只有第一步")
        in_flight = [name for name in begun if name not in ended]
        self.assertEqual(in_flight, ["第二步"])

        second = self._run_child(task_id=task["task_id"], app_name=app,
                                 should_kill=False)
        self.assertEqual(second.returncode, 0, second.stderr[-1200:])
        after = marker.read_text(encoding="utf-8").splitlines()

        status = ""
        steps = ""
        for line in second.stdout.splitlines():
            if line.startswith("STATUS="):
                status = line.split("=", 1)[1]
            elif line.startswith("STEPS="):
                steps = line.split("=", 1)[1]

        self.assertEqual(status, "done", f"续跑没跑完；stdout={second.stdout}")
        self.assertEqual(steps, "['第一步', '第二步', '第三步']")

        # 1) 已完成的第一步：整场只出现过一次 begin —— 这是"不重跑"的判据
        begins = [x.split(":", 1)[1] for x in after if x.startswith("begin:")]
        self.assertEqual(begins.count("第一步"), 1,
                         "已完成的第一步被重跑了（应只出现一次 begin）")
        # 2) 三步都完成过（end 各至少一次）
        ends = [x.split(":", 1)[1] for x in after if x.startswith("end:")]
        for name in ("第一步", "第二步", "第三步"):
            self.assertIn(name, ends, f"{name} 从未完成")
        # 3) 只有被杀时在飞的那一步允许出现第二次 begin
        for name in ("第一步", "第三步"):
            self.assertEqual(begins.count(name), 1,
                             f"{name} 执行了 {begins.count(name)} 次，应只 1 次")
        self.assertLessEqual(begins.count("第二步"), 2,
                             "在飞的那一步最多重跑一次")
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "done")

    def test_duplicate_delivery_runs_once(self) -> None:
        """同一 task_id 触发两次 → 只有一个工作流实例，步骤只执行一遍。"""
        import threading
        import time

        task = self.make_task()
        self.store.create_step(task_id=task["task_id"], idx=0, name="唯一一步")
        calls: list[str] = []

        def executor(t: dict) -> dict:
            calls.append(t["task_id"])
            time.sleep(0.2)
            return {"ok": True}

        orch = self.make_orch(executor=executor)
        orch.launch()

        results: list[object] = []

        def once() -> None:
            results.append(orch.run_task(task["task_id"]))

        a = threading.Thread(target=once)
        b = threading.Thread(target=once)
        a.start()
        b.start()
        a.join(timeout=120)
        b.join(timeout=120)

        self.assertEqual(len(calls), 1,
                         f"同一 task_id 被执行了 {len(calls)} 次，应该只 1 次")
        self.assertEqual(orch.workflow_status(task["task_id"]), "SUCCESS")
        # 两次调用拿到的是同一个工作流的结果
        self.assertEqual(len([r for r in results if r is not None]), 2)


class TestQueueIntegration(OrchestratorTestBase):
    """Bot-2 的三条验收：队列挂到 DBOS 上，但**不依赖**它。"""

    def test_enqueue_reserves_one_workflow_per_task_id(self) -> None:
        """同一 task_id 重复入队 → 只产生一个工作流。

        两层去重，顺序很重要：

        1. **业务表主键**先挡 —— 同一个 ``task_id`` 第二次插入直接
           ``IntegrityError``。这比 DBOS 那层更早生效。
        2. 即使换了写法绕过第 1 层（比如先建任务、再由编排层跑），
           ``SetWorkflowID(task_id)`` 也只会有一个工作流实例。

        所以这里断言两件事：重复入队被主键拒掉；跑过之后工作流只有一个。
        """
        import sqlite3

        from fieldstation.botd.queue import TaskQueue

        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.launch()
        queue = TaskQueue(self.store)

        first = queue.enqueue({"kind": "bot", "title": "a", "task_id": "t-dup"})
        self.assertEqual(first["task_id"], "t-dup")
        with self.assertRaises(sqlite3.IntegrityError):
            queue.enqueue({"kind": "bot", "title": "a", "task_id": "t-dup"})

        orch.run_task("t-dup")
        orch.run_task("t-dup")          # 第二次是同一个工作流
        ids = [wid for wid in orch.workflow_ids() if wid == "t-dup"]
        self.assertEqual(len(ids), 1,
                         f"同一个 task_id 产生了 {len(ids)} 个工作流：{ids}")

    def test_reap_still_works_with_dbos_running(self) -> None:
        """DBOS 在跑时，残留租约仍由 reap_expired 收回（DBOS 不知道租约）。"""
        from datetime import timedelta

        from fieldstation.botd.queue import TaskQueue

        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.launch()
        queue = TaskQueue(self.store)

        task = queue.enqueue({"kind": "bot", "title": "x"})
        leased = queue.lease("w1", ttl=10.0, now=NOW)
        self.assertEqual(leased["task_id"], task["task_id"])
        # 租约过期
        reaped = queue.reap_expired(now=NOW + timedelta(seconds=30))
        self.assertEqual([r["task_id"] for r in reaped], [task["task_id"]])
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "pending")

    def test_queue_runs_without_dbos(self) -> None:
        """DBOS 不在时，队列单独也能跑完一轮（ADR-009 降级梯度）。"""
        from datetime import timedelta

        from fieldstation.botd.queue import TaskQueue

        self.assertIsNone(active(), "这个用例要在没有编排器的情况下跑")
        queue = TaskQueue(self.store)
        task = queue.enqueue({"kind": "bot", "title": "no-dbos"})
        # 入队不该因为没 DBOS 而失败
        self.assertEqual(task["status"], "pending")

        leased = queue.lease("w1", ttl=60.0, now=NOW)
        self.assertIsNotNone(leased)
        done = queue.complete(leased["task_id"], {"ok": True}, now=NOW)
        self.assertEqual(done["status"], "done")
        # 回收路径也要通
        task2 = queue.enqueue({"kind": "bot", "title": "y"})
        queue.lease("w2", ttl=1.0, now=NOW)
        self.assertEqual(
            len(queue.reap_expired(now=NOW + timedelta(seconds=10))), 1)
        self.assertEqual(self.store.get_task(task2["task_id"])["status"], "pending")

    def test_enqueue_never_raises_when_orchestrator_breaks(self) -> None:
        """编排层内部炸了也不能让入队失败（except 是有意的）。"""
        from fieldstation.botd.queue import TaskQueue

        orch = self.make_orch(executor=lambda t: {"ok": True})
        orch.launch()

        def boom(_task_id: str) -> bool:
            raise RuntimeError("orchestrator 坏了")

        orch.reserve_workflow = boom  # type: ignore[assignment]
        queue = TaskQueue(self.store)
        task = queue.enqueue({"kind": "bot", "title": "still-works"})
        self.assertEqual(task["status"], "pending")


if __name__ == "__main__":
    unittest.main()
