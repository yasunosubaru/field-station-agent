"""`botd/interaction.py`：任务树、事件流、三种受控干预。

## 为什么这层值得单独测

`store` 已经有四张表、`supervisor` 已经有拆步，但"人能不能看懂现在卡在哪"
和"点了暂停会不会真的停"这两件事，都不是那两层的职责。而它们各自有两种典型错法：

* **任务树错**：步骤与子任务对不上号 → 界面显示"3 步全完成"但没有任何一步真跑过；
* **干预错**：把"要暂停"记成"已暂停" → 用户以为停了，实际还在跑。

第二种最危险：它让**审计记录与事实相反**。所以下面每条干预测试都同时断言
"数据库里写了什么"和"没有写什么"。

## 不测什么

不测 `Supervisor._drive()` 在步骤边界怎么消费干预 —— 那是 DBOS 那侧的循环，
本模块只负责"记下要暂停"并说明"什么时候生效"（见模块 docstring 的分工说明）。
把两边的"边界"定义各写一份，迟早不一致。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.botd.interaction import (
    INTERVENTION_KINDS,
    InteractionBoard,
    InterventionError,
    summarize_kinds,
)
from fieldstation.botd.store import BotStore
from fieldstation.botd.supervisor import StepSpec, Supervisor


class FixedPlanner:
    def __init__(self, specs):
        self._specs = list(specs)

    def plan(self, task):
        return list(self._specs)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = BotStore(Path(self._tmp.name) / "botd.sqlite3")
        self.board = InteractionBoard(self.store)

    def make_run(self, steps=3, kind="data_qc"):
        specs = [StepSpec(name=f"步骤{i + 1}", tools=("data.read",))
                 for i in range(steps)]
        sup = Supervisor(self.store, planner=FixedPlanner(specs))
        return sup.run({"kind": kind, "bot_id": "bot1", "payload": {"q": "x"}})


class TreeTest(Base):
    def test_tree_links_steps_to_child_tasks(self):
        run = self.make_run(steps=3)
        tree = self.board.tree(run.task_id)
        self.assertEqual(tree["root"]["task_id"], run.task_id)
        self.assertEqual(len(tree["steps"]), 3)
        self.assertEqual(len(tree["children"]), 3)
        # 每个 step 都必须能指到执行它的那个子任务 —— 指不到的话，
        # 界面上点一步就不知道"这一步是哪个 bot 在跑"。
        for step in tree["steps"]:
            self.assertIsNotNone(step["task"], f"步骤 {step['name']} 没关联到子任务")
            self.assertEqual(step["task"]["step_id"], step["id"])

    def test_steps_sorted_by_idx(self):
        run = self.make_run(steps=4)
        tree = self.board.tree(run.task_id)
        idx = [int(s["idx"]) for s in tree["steps"]]
        self.assertEqual(idx, sorted(idx), "任务树的顺序必须稳定，否则每次刷新位置都在跳")

    def test_counts_reflect_status(self):
        run = self.make_run(steps=2)
        tree = self.board.tree(run.task_id)
        c = tree["counts"]
        self.assertEqual(c["steps"], 2)
        self.assertEqual(c["done"] + c["failed"] + c["pending"], 2)

    def test_forest_only_top_level(self):
        run = self.make_run(steps=2)
        forest = self.board.forest()
        ids = [f["task"]["task_id"] for f in forest]
        self.assertIn(run.task_id, ids)
        # 子任务不该出现在首屏列表里
        for child in self.store.list_tasks(parent_task_id=run.task_id):
            self.assertNotIn(child["task_id"], ids)

    def test_forest_counts(self):
        run = self.make_run(steps=3)
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        self.assertEqual(entry["step_count"], 3)
        self.assertEqual(entry["done"] + entry["failed"], 0, "刚建的任务不该有完成/失败")


class EventStreamTest(Base):
    def test_dispatched_is_first(self):
        run = self.make_run(steps=2)
        flow = self.board.event_stream(run.task_id)
        self.assertEqual(flow[0]["phase"], "dispatched")
        self.assertEqual(flow[0]["task_id"], run.task_id)

    def test_every_step_has_a_phase(self):
        run = self.make_run(steps=3)
        flow = self.board.event_stream(run.task_id)
        step_phases = [e for e in flow if "step_id" in e and e["phase"] != "retried"]
        self.assertEqual(len(step_phases), 3)
        for event in step_phases:
            self.assertIn(event["phase"], ("queued", "running", "completed", "failed"))

    def test_interventions_appear_in_stream(self):
        run = self.make_run(steps=2)
        self.board.request("pause", task_id=run.task_id, prompt="先停一下")
        flow = self.board.event_stream(run.task_id)
        kinds = [e["phase"] for e in flow]
        self.assertIn("intervention:pause", kinds)

    def test_missing_timestamp_is_not_invented(self):
        """没有时间就是没有，不许编一个时间戳出来。"""
        run = self.make_run(steps=1)
        flow = self.board.event_stream(run.task_id)
        for event in flow:
            self.assertIn("at", event)
            self.assertTrue(event["at"] is None or isinstance(event["at"], str))


class RequestTest(Base):
    def test_unknown_kind_rejected(self):
        run = self.make_run()
        with self.assertRaises(InterventionError):
            self.board.request("delete_everything", task_id=run.task_id)
        # 关键：拒绝之后表里不许留下脏行
        self.assertEqual(self.store.list_interventions(), [])

    def test_requires_target(self):
        with self.assertRaises(InterventionError):
            self.board.request("pause")
        self.assertEqual(self.store.list_interventions(), [])

    def test_pause_is_recorded_as_pending_not_as_done(self):
        """最危险的错法：把"要暂停"记成"已暂停"。"""
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id, prompt="停")
        self.assertEqual(row["status"], "pending")
        stored = self.store.get_intervention(row["id"])
        self.assertEqual(stored["status"], "pending", "点了暂停不等于已经停了")

    def test_pause_effective_at_next_step_boundary(self):
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        self.assertEqual(row["effective_at"]["when"], "next_step_boundary")
        self.assertIn("工具中途", row["effective_at"]["note"])

    def test_pause_needs_no_approval(self):
        """出故障时要立刻停，让人等审批是反的。"""
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        self.assertFalse(row["needs_approval"])

    def test_takeover_requires_approval(self):
        run = self.make_run()
        with self.assertRaises(InterventionError) as ctx:
            self.board.request("takeover", task_id=run.task_id, prompt="我来")
        self.assertIn("审批", str(ctx.exception))
        self.assertEqual(self.store.list_interventions(), [], "没有审批就不许落库")

    def test_takeover_with_approval_accepted(self):
        run = self.make_run()
        row = self.board.request("takeover", task_id=run.task_id, prompt="我来",
                                 approval_id="ap-01")
        self.assertTrue(row["needs_approval"])
        self.assertEqual(row["status"], "pending")
        self.assertIn("ap-01", row["prompt"])

    def test_retry_requires_explanation(self):
        """ADR-009 要求"改参重试（记审计）"。没有说明的重试无法解释输入变更。"""
        run = self.make_run()
        with self.assertRaises(InterventionError) as ctx:
            self.board.request("retry", task_id=run.task_id)
        self.assertIn("改了什么", str(ctx.exception))

    def test_retry_with_parametrized_flag_accepted(self):
        run = self.make_run()
        row = self.board.request("retry", task_id=run.task_id, parametrized=True)
        self.assertIn("parametrized=True", row["prompt"])

    def test_retry_with_note_accepted(self):
        run = self.make_run()
        row = self.board.request("retry", task_id=run.task_id, prompt="把阈值从 5 改成 8")
        self.assertIn("阈值", row["prompt"])

    def test_step_id_survives_roundtrip(self):
        """`intervention` 表只有 prompt 一个自由字段，step_id 拼进去要能取回来。"""
        run = self.make_run(steps=2)
        step_id = self.store.list_steps(run.task_id)[1]["id"]
        row = self.board.request("retry", task_id=run.task_id, prompt="改参",
                                 step_id=step_id)
        self.assertEqual(row["effective_at"]["step_id"], step_id)
        pending = self.board.pending()
        self.assertEqual(pending[0]["effective_at"]["step_id"], step_id)

    def test_by_bot_id_also_allowed(self):
        row = self.board.request("pause", bot_id="bot1", prompt="这台先停")
        self.assertEqual(row["bot_id"], "bot1")


class ResolveTest(Base):
    def test_resolve_moves_out_of_pending(self):
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        resolved = self.board.resolve(row["id"], "已停")
        self.assertEqual(resolved["status"], "resolved")
        self.assertEqual(self.board.pending(), [])

    def test_reject_is_terminal_too(self):
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        out = self.board.resolve(row["id"], "不需要停", status="rejected")
        self.assertEqual(out["status"], "rejected")

    def test_terminal_rows_cannot_be_rewritten(self):
        """干预是审计记录，允许反复改写等于允许篡改。"""
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        self.board.resolve(row["id"], "已停")
        with self.assertRaises(InterventionError) as ctx:
            self.board.resolve(row["id"], "改主意了")
        self.assertIn("终态", str(ctx.exception))

    def test_bad_status_rejected(self):
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        with self.assertRaises(InterventionError):
            self.board.resolve(row["id"], "x", status="maybe")


class PendingTest(Base):
    def test_pending_sorted_oldest_first(self):
        run = self.make_run()
        first = self.board.request("pause", task_id=run.task_id, prompt="先")
        second = self.board.request("resume", task_id=run.task_id, prompt="后")
        ids = [r["id"] for r in self.board.pending()]
        self.assertEqual(ids[:2], [first["id"], second["id"]],
                         "待办是队列，不是流水账")

    def test_pending_filtered_by_task(self):
        a = self.make_run(kind="data_qc")
        b = self.make_run(kind="report")
        self.board.request("pause", task_id=a.task_id)
        self.board.request("pause", task_id=b.task_id)
        self.assertEqual(len(self.board.pending()), 2)
        self.assertEqual(len(self.board.pending(task_id=a.task_id)), 1)

    def test_forest_counts_open_interventions(self):
        run = self.make_run()
        self.board.request("pause", task_id=run.task_id)
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        self.assertEqual(entry["open_interventions"], 1)


class KindsTest(unittest.TestCase):
    def test_all_four_kinds_supported(self):
        self.assertEqual(set(INTERVENTION_KINDS),
                         {"pause", "resume", "retry", "takeover"})

    def test_summarize_counts(self):
        rows = [{"kind": "pause"}, {"kind": "pause"}, {"kind": "retry"},
                {"kind": "unknown_kind"}]
        counts = summarize_kinds(rows)
        self.assertEqual(counts["pause"], 2)
        self.assertEqual(counts["retry"], 1)
        self.assertEqual(counts["takeover"], 0)
        self.assertNotIn("unknown_kind", counts, "未知类型不进计数，免得界面出现幽灵项")


class RegressionTest(Base):
    """三个由组合测试发现的 bug 的回归钉。

    这三条都是"单测全绿、组合起来才暴露"的错法，所以每条都要留测试——
    只修不加测试，下次重构会原样复活。
    """

    def test_failed_step_error_is_not_empty(self) -> None:
        """`step` 表的列名是 `error`，`last_error` 是 task 表的。

        拿错列名不报错，只是永远取到空串：事件流上看得见"失败"却看不到原因。
        """
        run = self.make_run(steps=1)
        step = self.store.list_steps(run.task_id)[0]
        self.store.update_step(step["id"], status="failed",
                               error="阈值超限 8 > 5")
        flow = self.board.event_stream(run.task_id)
        failed = next(e for e in flow if e["phase"] == "failed")
        self.assertEqual(failed["error"], "阈值超限 8 > 5",
                         "失败原因必须是 step.error，不是 task.last_error")

    def test_cancelled_status_rejected_as_intervention_error(self) -> None:
        """`BotStore` 的白名单是 resolved/rejected/expired，没有 cancelled。

        三处定义不一致时，调用方 `except InterventionError` 会漏掉 `ValueError`。
        """
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        with self.assertRaises(InterventionError) as ctx:
            self.board.resolve(row["id"], "算了", status="cancelled")
        self.assertIn("resolved", str(ctx.exception))
        # 关键：拒绝之后状态没被改
        self.assertEqual(self.store.get_intervention(row["id"])["status"], "pending")

    def test_expired_status_is_supported(self) -> None:
        """`expired` 是白名单里有的，必须真的能写进去。"""
        run = self.make_run()
        row = self.board.request("pause", task_id=run.task_id)
        out = self.board.resolve(row["id"], "超时未处理", status="expired")
        self.assertEqual(out["status"], "expired")
        self.assertEqual(self.board.pending(), [])

    def test_skipped_step_counted_and_labelled(self) -> None:
        """`skipped` 是 STEP_STATUSES 的合法值。

        不单列时 done+failed+pending != steps，进度条会卡在 N/N+1；
        归进 queued 又会写成"待执行：跳过的一步"，读起来像还在排队。
        """
        run = self.make_run(steps=2)
        steps = self.store.list_steps(run.task_id)
        self.store.update_step(steps[0]["id"], status="done")
        self.store.update_step(steps[1]["id"], status="skipped")

        tree = self.board.tree(run.task_id)
        counts = tree["counts"]
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(counts["done"], 1)
        # 五个状态必须能完整覆盖，否则合计对不上
        self.assertEqual(
            counts["done"] + counts["failed"] + counts["skipped"] + counts["pending"],
            counts["steps"],
            f"合计与步骤数不符：{counts}")

        flow = self.board.event_stream(run.task_id)
        skipped = [e for e in flow if e.get("phase") == "skipped"]
        self.assertEqual(len(skipped), 1)
        self.assertIn("跳过", skipped[0]["label"])


if __name__ == "__main__":
    unittest.main()
