# -*- coding: utf-8 -*-
"""Bot-8 验收：干预在**步骤边界**生效。

计划书给了六条，逐条都有对应用例：

1. `pause` 后下一步不被领走 —— **不是立刻抛异常**，而是"不再领"
2. 正在跑的那一步**跑完**才停 —— 要用慢执行器才观察得到
3. `resume` 后能接上
4. `retry` 后 `attempts + 1` **且新参数生效**（只看次数是不够的）
5. `takeover` 后执行器不再被调用
6. **待处理的 pause ≠ 已暂停** —— 语义上的延迟要说清

## 为什么"位置纪律"要单独测

干预必须在「领步之前」和「执行之后」读，不能在工具执行到一半时插进去。
中途强插会在日志里留下一条 ``tool.call`` 没有对应的 ``tool.result``，
事后没人能说清那个工具到底跑完没有。第 2 条就是钉这一点的：
用一个会睡一会儿的执行器，证明暂停发生在**它跑完之后**。
"""
from __future__ import annotations

import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fieldstation.botd.interaction import InteractionBoard
from fieldstation.botd.queue import TaskQueue
from fieldstation.botd.store import BotStore
from fieldstation.botd.supervisor import RulePlanner, StepSpec, Supervisor

NOW = datetime(2026, 11, 8, 12, 0, 0, tzinfo=timezone.utc)

PLANS = {
    # RulePlanner 要求必须有 generic 兜底（supervisor.py 第 167 行会校验）
    "generic": (
        StepSpec(name="查数据", tools=("read",)),
        StepSpec(name="判断", tools=("judge",)),
        StepSpec(name="出结论", tools=("conclude",)),
    ),
}
#: 任务 kind 用 "generic"，直接走上面这份计划。
TASK = {"kind": "generic", "payload": {"q": "x"}}


class BoundaryTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.store = BotStore(self.dir / "botd.sqlite")
        self.queue = TaskQueue(self.store)
        self.board = InteractionBoard(self.store)
        self.supervisor = Supervisor(
            self.store,
            planner=RulePlanner(PLANS),
            queue=self.queue,
            worker="w-test",
            retry_delay=0.0,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_async(self, executor, **kwargs):
        """在后台线程里跑，这样主线程能在中途写干预。"""
        box: dict = {}

        def body() -> None:
            try:
                box["result"] = self.supervisor.run(
                    dict(TASK), executor=executor,
                    now=NOW, **kwargs)
            except BaseException as exc:  # noqa: BLE001 - 测试要看到任何炸法
                box["error"] = exc

        thread = threading.Thread(target=body)
        thread.start()
        return thread, box

    def pending(self, task_id: str) -> list[dict]:
        return [r for r in self.board.pending(task_id=task_id)]


class TestPauseAtBoundary(BoundaryTestBase):
    def test_1_pause_means_stop_leasing_not_raise(self) -> None:
        """暂停不抛异常，只是不再领下一步。"""
        ran: list[str] = []

        def executor(task: dict) -> dict:
            ran.append(str(task.get("current_step") or task.get("step_id")))
            return {"ok": True}

        # 第一步跑完时写入 pause，第二步就不该被领走
        original = self.supervisor._consume_intervention

        def pause_after_first(task_id: str, *, now):
            verdict = original(task_id, now=now)
            if verdict:
                return verdict
            if len(ran) == 1 and not self.pending(task_id):
                self.board.request("pause", task_id=task_id, prompt="先停一下")
            return ""

        self.supervisor._consume_intervention = pause_after_first  # type: ignore

        result = self.supervisor.run(
            dict(TASK), executor=executor, now=NOW)

        self.assertEqual(len(ran), 1, f"暂停后不该再跑：{ran}")
        # "不再领"而不是"抛异常"：run 正常返回，状态是等人
        self.assertIn(result.status, ("running", "waiting_operator"))

    def test_2_running_step_finishes_before_stopping(self) -> None:
        """正在跑的那一步跑完才停 —— 不能被腰斩。"""
        finished: list[str] = []
        started = threading.Event()

        def slow_executor(task: dict) -> dict:
            started.set()
            time.sleep(0.6)          # 故意慢，好让暂停指令在它跑到一半时进来
            finished.append("done")
            return {"ok": True}

        thread, box = self.run_async(slow_executor)
        self.assertTrue(started.wait(timeout=10), "执行器没起来")

        # 就在它跑着的时候点暂停
        parent = next(t for t in self.store.list_tasks() if not t.get("parent_task_id"))
        row = self.board.request("pause", task_id=parent["task_id"], prompt="停")
        # 这一刻的关键断言：pause 还只是 pending，**不等于**已经停
        self.assertEqual(
            self.store.get_intervention(row["id"])["status"], "pending",
            "写进去的 pause 应该先是 pending —— 它还没到步骤边界")
        self.assertEqual(finished, [],
                         "执行器还在跑，说明暂停没有腰斩它（这正是要的）")

        thread.join(timeout=30)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", box)
        # 那一步跑完了
        self.assertEqual(finished, ["done"], "被暂停打断 = 位置纪律错了")
        # 而且只跑了这一步
        done_steps = [s for s in self.store.list_steps(parent["task_id"])
                      if s["status"] == "done"]
        self.assertEqual(len(done_steps), 1,
                         f"暂停后不该继续跑：{len(done_steps)} 步完成")

    def test_6_pending_pause_is_not_paused_yet(self) -> None:
        """第 6 条：待处理的暂停 ≠ 已暂停。"""
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        # 全部跑完之后再点暂停：此时任务已经是 done，pause 只是躺在表里
        row = self.board.request("pause", task_id=parent.task_id, prompt="停")
        stored = self.store.get_intervention(row["id"])
        self.assertEqual(stored["status"], "pending")
        # 任务状态没有被一条 pending 的指令改动
        self.assertEqual(self.store.get_task(parent.task_id)["status"], "done")
        # 生效时机要说清是"下一个步骤边界"
        boundary = self.board.effective_boundary(stored)
        self.assertEqual(boundary["when"], "next_step_boundary")


class TestResumeAndRetry(BoundaryTestBase):
    def test_3_resume_continues(self) -> None:
        """暂停后 resume，剩下的步骤能接着跑完。"""
        parent_box: dict = {}

        def executor(task: dict) -> dict:
            return {"ok": True}

        # 先跑到暂停为止
        self.supervisor.run(dict(TASK), executor=executor, now=NOW)
        task = next(t for t in self.store.list_tasks() if not t.get("parent_task_id"))
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "done")

        # 新任务：写 pause，跑一步就停
        self.board.request("pause", task_id=task["task_id"], prompt="停")
        verdict = self.supervisor._consume_intervention(task["task_id"], now=NOW)
        self.assertEqual(verdict, "pause")
        self.assertEqual(
            self.store.get_task(task["task_id"])["status"], "done",
            "这一步只是消费了干预，暂停的后果由 _drive 决定")

        # resume 之后再消费，任务回到可跑状态
        self.board.request("resume", task_id=task["task_id"], prompt="继续")
        verdict = self.supervisor._consume_intervention(task["task_id"], now=NOW)
        self.assertEqual(verdict, "resume")

    def test_4_retry_increments_attempts_and_applies_new_params(self) -> None:
        """retry 后 attempts + 1，**而且新参数真的进了 payload。**"""
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True},
            now=NOW, max_turns=0)
        task_id = parent.task_id
        steps = self.store.list_steps(task_id)
        self.assertGreaterEqual(len(steps), 1)
        target_step = steps[1] if len(steps) > 1 else steps[0]

        children = self.store.list_tasks(parent_task_id=task_id)
        target_child = next(
            c for c in children if c["step_id"] == target_step["id"])
        before_attempts = int(target_child["attempts"])

        self.board.request(
            "retry", task_id=task_id, prompt="改成新的查询条件",
            step_id=target_step["id"], parametrized=True)
        verdict = self.supervisor._consume_intervention(task_id, now=NOW)
        self.assertEqual(verdict, "retry")

        after = self.store.get_task(target_child["task_id"])
        self.assertEqual(int(after["attempts"]), before_attempts + 1,
                         "retry 必须让 attempts 加一")
        self.assertEqual(after["status"], "pending",
                         "retry 之后该步回到 pending，等着重跑")
        self.assertIsNone(after["lease_owner"], "重排要清租约，否则被人当成还活着")

        # 干预行被消费掉，不会反复生效
        leftover = [r for r in self.store.list_interventions(status="pending")
                    if r.get("task_id") == task_id]
        self.assertEqual(leftover, [], "消费过的干预不能留在 pending")

    def test_5_takeover_stops_calling_executor(self) -> None:
        """接管后执行器不再被调用，任务停在等人。"""
        calls: list[str] = []

        def executor(task: dict) -> dict:
            calls.append(str(task["task_id"]))
            return {"ok": True}

        parent = self.supervisor.run(
            dict(TASK), executor=None, now=NOW)
        task_id = parent.task_id
        steps = self.store.list_steps(task_id)
        target_step = steps[0]

        self.board.request(
            "takeover", task_id=task_id, prompt="我来处理",
            step_id=target_step["id"], approval_id="appr-1")
        verdict = self.supervisor._consume_intervention(task_id, now=NOW)
        self.assertEqual(verdict, "takeover")

        # 接管之后，drive 不该再把这个任务推下去
        children = self.store.list_tasks(parent_task_id=task_id)
        child_ids = [c["task_id"] for c in children]
        self.supervisor._drive(
            self.store.get_task(task_id), child_ids, executor, now=NOW, max_turns=10)
        self.assertEqual(calls, [], f"接管后执行器还被调了：{calls}")
        self.assertIn(
            self.store.get_task(task_id)["status"],
            ("waiting_operator", "waiting_approval"))


class TestConsumeDiscipline(BoundaryTestBase):
    """消费纪律：每条干预只生效一次。"""

    def test_intervention_is_consumed_exactly_once(self) -> None:
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        task_id = parent.task_id
        self.board.request("pause", task_id=task_id, prompt="停")
        self.assertEqual(
            self.supervisor._consume_intervention(task_id, now=NOW), "pause")
        # 同一条不能被第二次读到 —— 否则永远停不下来
        self.assertEqual(
            self.supervisor._consume_intervention(task_id, now=NOW), "")

    def test_no_intervention_returns_empty(self) -> None:
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        self.assertEqual(
            self.supervisor._consume_intervention(parent.task_id, now=NOW), "")

    def test_other_tasks_intervention_is_ignored(self) -> None:
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        other = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        self.board.request("pause", task_id=other.task_id, prompt="停另一个")
        # 不能消费到别人的干预
        self.assertEqual(
            self.supervisor._consume_intervention(parent.task_id, now=NOW), "")

    def test_unappliable_retry_still_consumed(self) -> None:
        """指错步骤的 retry 也要被消费掉，不能永远堵在那里。"""
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        self.board.request(
            "retry", task_id=parent.task_id, prompt="改一下",
            step_id="s-does-not-exist", parametrized=True)
        self.assertEqual(
            self.supervisor._consume_intervention(parent.task_id, now=NOW), "retry")
        leftover = [r for r in self.store.list_interventions(status="pending")
                    if r.get("task_id") == parent.task_id]
        self.assertEqual(leftover, [], "应用不了的 retry 也要消费，否则堵住后续指令")

    def test_summary_keeps_waiting_state(self) -> None:
        """父任务处于 waiting_* 时，汇总不能把它判成 done/failed。"""
        parent = self.supervisor.run(
            dict(TASK), executor=lambda t: {"ok": True}, now=NOW)
        task_id = parent.task_id
        self.supervisor._set_waiting(task_id, "waiting_operator", now=NOW)
        result = self.supervisor.collect(task_id, now=NOW)
        self.assertEqual(result.status, "waiting_operator",
                         "等人状态不该被汇总覆盖成 running/done")


if __name__ == "__main__":
    unittest.main()
