"""组合测试：任务树 + 事件流 + 干预 + 记忆执行器**一起用**时还对得上吗。

## 为什么不重复 `test_botd_interaction.py`

那份测试把 `InteractionBoard` 当成一个孤立对象测：树是树、流是流、干预是干预。
但编队台真正会遇到的错法几乎都发生在**接缝**上：

* 树显示"三步全完成"，可那三步根本没跑过（`Supervisor` 与 `board` 各读了一套状态）；
* 事件流里写着"完成"，`step.status` 却是 `failed`（两套口径各算各的）；
* 点了暂停之后，已经完成的步骤被改回 `pending` —— 用户以为回滚了，实际只是记了一条待办。

所以这里的每条用例都**先真跑一轮**（`Supervisor.run(executor=MemoryExecutor(...))`），
再拿 `board` 去读同一份 SQLite。这样"接缝错位"才会暴露成断言失败，而不是一个
看起来正常、对用户撒谎的界面。

## 记忆用纯本地的

`BotMemory(store)` 不带 backend（不碰 Letta / Chroma）：组合测试不该依赖外部服务，
而"记忆执行器真的跑起来了"这一点用本地召回就能证明——召回结果为空说明 payload 丢了，
那正是 `test_botd_executors.py` 那条坑。

## 已知缺陷（本文件不修，只记录，避免用断言把 bug 钉成"期望行为"）

1. `event_stream()` 给失败事件取的字段是 `step.get("last_error")`，而 `step` 表里
   那一列的列名是 `error`（`last_error` 是 `task` 表的列）。所以失败事件的 `error`
   **永远是空串**。已实测确认（见交付说明），未修改 `interaction.py`。
2. `InteractionBoard.resolve(..., status="cancelled")` 的 docstring 与入参校验都接受
   `cancelled`，但 `BotStore.resolve_intervention()` 只接受
   `resolved` / `rejected` / `expired`，于是 `cancelled` 会抛 `ValueError` 而不是
   `InterventionError`。同样未修改。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.botd import (
    INTERVENTION_KINDS,
    BotMemory,
    BotStore,
    InteractionBoard,
    InterventionError,
    MemoryExecutor,
    StepSpec,
    Supervisor,
    summarize_kinds,
)
from fieldstation.botd import __all__ as BOTD_ALL

#: `step.status` → `event_stream()` 该出现的 phase。
#: 这张表就是"状态与事件必须一致"的定义；两边口径一旦分叉，下面每条断言都会红。
STATUS_TO_PHASE = {
    "done": "completed",
    "failed": "failed",
    "pending": "queued",
    "running": "running",
}


class FixedPlanner:
    """按固定步骤表作答（`Supervisor` 要的是对象，不是函数）。"""

    def __init__(self, specs) -> None:
        self._specs = list(specs)

    def plan(self, task):
        return list(self._specs)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = BotStore(Path(self._tmp.name) / "botd.sqlite3")
        self.board = InteractionBoard(self.store)
        # 不带 backend：纯本地记忆，不连 Letta / Chroma。组合测试不该依赖外部服务。
        self.memory = BotMemory(self.store)

    # ------------------------------------------------------------------ 造场景
    def run_memory_task(self, *, payload=None, steps=None):
        """真跑一轮带记忆步骤的任务，返回 `RunResult`。

        默认两步都是记忆工具：一步召回、一步写入。这样执行器**每一句**都走
        `MemoryExecutor`，跑得通就说明 `Supervisor` → 队列 → 执行器 → 库 这条线是通的，
        而不是"因为没人调工具所以看起来成功"。
        """
        specs = steps or [
            StepSpec(name="召回历史记忆", tools=("memory.recall",), acceptance="拿到历史记忆"),
            StepSpec(name="归档本轮结论", tools=("memory.remember",), acceptance="结论可被下次召回"),
        ]
        sup = Supervisor(self.store, planner=FixedPlanner(specs))
        return sup.run(
            {"kind": "data_qc", "bot_id": "bot1",
             "payload": payload or {"query": "电池", "content": "本轮结论：无异常"}},
            executor=MemoryExecutor(self.memory).as_executor(),
        )

    def run_failing_task(self):
        """跑一个必失败的任务：一眼的工具不在执行器白名单里，且没给 fallback。

        `max_attempts=1` 是为了让它一步就落到 `failed` —— 组合测试要的是终态形状，
        不是重试节奏（那由 `test_botd_supervisor.py` 管）。
        """
        sup = Supervisor(
            self.store,
            planner=FixedPlanner([StepSpec(name="没装工具的一步", tools=("data.read",))]),
            max_attempts=1,
            retry_delay=0,
        )
        return sup.run({"kind": "data_qc", "bot_id": "bot1"},
                       executor=MemoryExecutor(self.memory).as_executor())

    def phase_by_step(self, task_id):
        """`{step_id: phase}`；`retried` 是同一状态的重复标注，不参与这一步的判等。"""
        phases = {}
        for event in self.board.event_stream(task_id):
            if "step_id" in event and event["phase"] != "retried":
                phases[event["step_id"]] = event["phase"]
        return phases


# ============================================================== 1. 真跑一轮再看树
class TreeAfterRealRun(Base):
    def test_done_steps_show_up_as_done_in_tree(self):
        self.memory.remember("bot1", "电池电压过低会丢星，先查供电")
        run = self.run_memory_task()
        self.assertEqual(run.status, "done", run)

        tree = self.board.tree(run.task_id)
        self.assertEqual(len(tree["steps"]), 2)
        for step in tree["steps"]:
            self.assertEqual(step["status"], "done",
                             f"步骤 {step['name']} 没跑完，树却在展示它")

    def test_counts_done_matches_step_statuses(self):
        run = self.run_memory_task()
        tree = self.board.tree(run.task_id)
        done = [s for s in tree["steps"] if s["status"] == "done"]
        self.assertEqual(tree["counts"]["done"], len(done))
        self.assertEqual(tree["counts"]["steps"], len(tree["steps"]))
        self.assertEqual(tree["counts"]["failed"], 0)

    def test_step_output_proves_executor_really_ran(self):
        """状态 `done` 本身不算证据 —— 执行器的返回值里必须有真实召回结果。"""
        self.memory.remember("bot1", "电池电压过低会丢星，先查供电")
        run = self.run_memory_task()
        first = self.board.tree(run.task_id)["steps"][0]
        output = first["output"] or {}
        self.assertTrue(output.get("ok"), output)
        self.assertGreaterEqual(output.get("count", 0), 1,
                                f"召回为空说明 payload 在接缝上丢了：{output}")
        self.assertFalse(output.get("memory_missing"))

    def test_step_points_at_the_child_task_that_ran_it(self):
        """点开一步必须知道"这是哪个 bot 的任务"；指不到就是树与队列脱节。"""
        run = self.run_memory_task()
        for step in self.board.tree(run.task_id)["steps"]:
            self.assertIsNotNone(step["task"], f"步骤 {step['name']} 没关联到子任务")
            self.assertEqual(step["task"]["task_id"], step["task_ref"])
            self.assertEqual(step["task"]["step_id"], step["id"])


# ==================================================== 2. 事件流与真实状态一致
class EventStreamMatchesState(Base):
    def assert_phases_match(self, task_id):
        steps = {s["id"]: s for s in self.store.list_steps(task_id)}
        phases = self.phase_by_step(task_id)
        self.assertEqual(set(phases), set(steps),
                         "每个 step 都必须在这条流里出现且只出现一次（retried 除外）")
        for step_id, step in steps.items():
            expected = STATUS_TO_PHASE.get(step["status"])
            self.assertIsNotNone(expected, f"未覆盖的状态：{step['status']!r}")
            self.assertEqual(phases[step_id], expected,
                             f"步骤 {step['name']!r} 状态是 {step['status']}，"
                             f"事件流却说 {phases[step_id]}")

    def test_completed_run_matches(self):
        self.assert_phases_match(self.run_memory_task().task_id)

    def test_failed_step_matches(self):
        run = self.run_failing_task()
        self.assertEqual(run.status, "failed", run)
        self.assert_phases_match(run.task_id)
        phases = self.phase_by_step(run.task_id)
        self.assertEqual(list(phases.values()), ["failed"])

    def test_pending_steps_match(self):
        """`run(executor=None)` 只入队不执行：步骤该是 pending，流该说 queued。"""
        sup = Supervisor(self.store, planner=FixedPlanner(
            [StepSpec(name="待执行的一步", tools=("memory.recall",))]))
        run = sup.run({"kind": "data_qc", "bot_id": "bot1", "payload": {"query": "x"}})
        self.assert_phases_match(run.task_id)
        self.assertEqual(list(self.phase_by_step(run.task_id).values()), ["queued"])

    def test_dispatched_event_is_first_and_stream_is_ordered(self):
        flow = self.board.event_stream(self.run_memory_task().task_id)
        self.assertEqual(flow[0]["phase"], "dispatched")
        stamps = [e["at"] for e in flow if e.get("at")]
        self.assertEqual(stamps, sorted(stamps), "事件流必须按时间有序，否则用户看反了因果")

    def test_intervention_written_by_board_shows_up_as_pending_in_stream(self):
        run = self.run_memory_task()
        row = self.board.request("pause", task_id=run.task_id, prompt="先停一下")
        events = [e for e in self.board.event_stream(run.task_id)
                  if e["phase"] == "intervention:pause"]
        self.assertEqual(len(events), 1, "写了干预却在流里看不见，等于没写")
        self.assertEqual(events[0]["intervention_id"], row["id"])
        self.assertEqual(events[0]["status"], "pending",
                         "刚写下的干预是待办，不是已生效")


# ================================================== 3. 干预不影响已完成的部分
class InterventionDoesNotRewriteState(Base):
    def test_pause_after_completion_leaves_done_steps_done(self):
        """这条是整份文件的核心：**记下"要暂停"** 与 **改状态** 是两件事。"""
        run = self.run_memory_task()
        before = {s["id"]: s["status"] for s in self.store.list_steps(run.task_id)}
        counts_before = dict(self.board.tree(run.task_id)["counts"])

        row = self.board.request("pause", task_id=run.task_id, prompt="先停一下")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["effective_at"]["when"], "next_step_boundary")

        after = {s["id"]: s["status"] for s in self.store.list_steps(run.task_id)}
        self.assertEqual(after, before, "干预把已完成的步骤改回去了 —— 这是在篡改事实")
        self.assertEqual(self.board.tree(run.task_id)["counts"], counts_before)

    def test_pause_is_visible_in_pending_but_not_applied(self):
        run = self.run_memory_task()
        row = self.board.request("pause", task_id=run.task_id, prompt="先停一下")

        pending = self.board.pending(task_id=run.task_id)
        self.assertEqual([p["id"] for p in pending], [row["id"]])
        self.assertFalse(pending[0]["needs_approval"])
        # 而任务的真实状态没有因为"有人点了暂停"而变成 paused（表里没有这个状态）
        self.assertEqual(self.store.get_task(run.task_id)["status"], "done")

    def test_open_interventions_count_tracks_pending_only(self):
        run = self.run_memory_task()
        row = self.board.request("pause", task_id=run.task_id)
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        self.assertEqual(entry["open_interventions"], 1)

        self.board.resolve(row["id"], "已停")
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        self.assertEqual(entry["open_interventions"], 0, "已结论的干预不该还算待办")

    def test_resolving_pause_does_not_resurrect_steps(self):
        run = self.run_memory_task()
        before = {s["id"]: s["status"] for s in self.store.list_steps(run.task_id)}
        row = self.board.request("pause", task_id=run.task_id, prompt="先停一下")
        self.board.resolve(row["id"], "跑完了，不用停")
        after = {s["id"]: s["status"] for s in self.store.list_steps(run.task_id)}
        self.assertEqual(after, before)

    def test_summarize_kinds_counts_real_pending_rows(self):
        run = self.run_memory_task()
        self.board.request("pause", task_id=run.task_id)
        self.board.request("pause", task_id=run.task_id)
        self.board.request("retry", task_id=run.task_id, prompt="阈值 5 改 8")
        counts = summarize_kinds(self.board.pending(task_id=run.task_id))
        self.assertEqual(counts["pause"], 2)
        self.assertEqual(counts["retry"], 1)
        self.assertEqual(counts["takeover"], 0)


# ====================================================== 4. takeover 的审批链
class TakeoverApprovalChain(Base):
    def test_takeover_without_approval_is_rejected_and_writes_nothing(self):
        run = self.run_memory_task()
        with self.assertRaises(InterventionError) as ctx:
            self.board.request("takeover", task_id=run.task_id, prompt="我来")
        self.assertIn("审批", str(ctx.exception))
        self.assertEqual(self.store.list_interventions(), [],
                         "被拒的接管不许落库 —— 留一行就等于留了一张待批准的空白支票")

    def test_takeover_with_approval_is_pending_and_flags_approval(self):
        run = self.run_memory_task()
        step_id = self.board.tree(run.task_id)["steps"][1]["id"]
        row = self.board.request("takeover", task_id=run.task_id, prompt="我来接手",
                                 approval_id="ap-2026-11-07-01", step_id=step_id)
        self.assertEqual(row["status"], "pending")
        self.assertTrue(row["needs_approval"])
        self.assertEqual(row["effective_at"]["when"], "step_handover")
        self.assertEqual(row["effective_at"]["step_id"], step_id)

    def test_pending_lists_takeover_with_needs_approval_true(self):
        run = self.run_memory_task()
        self.board.request("takeover", task_id=run.task_id, prompt="我来",
                           approval_id="ap-01")
        item = self.board.pending(task_id=run.task_id)[0]
        self.assertTrue(item["needs_approval"])
        # `intervention` 表没有 metadata 列，审批号必须能从 prompt 里取回来
        self.assertIn("approval_id=ap-01", item["prompt"])

    def test_pause_needs_no_approval_but_takeover_does(self):
        """对照：出故障要立刻停，让人等审批是反的；接管才该过门。"""
        run = self.run_memory_task()
        self.assertFalse(self.board.request("pause", task_id=run.task_id)["needs_approval"])
        self.assertTrue(self.board.request("takeover", task_id=run.task_id,
                                           approval_id="ap-02")["needs_approval"])


# ============================================================= 5. 导出可用
class PackageExports(Base):
    def test_root_import_exposes_interaction_api(self):
        # 这里 import 的就是 `fieldstation.botd`，不是子模块路径：
        # 前端与别的包只写 `from fieldstation.botd import InteractionBoard`。
        from fieldstation.botd import (  # noqa: F401 - 断言的是"能导入"
            INTERVENTION_KINDS as kinds,
            InteractionBoard as board_cls,
            InterventionError as err_cls,
            MemoryExecutor as executor_cls,
            summarize_kinds as summarizer,
        )
        self.assertIs(board_cls, InteractionBoard)
        self.assertIs(err_cls, InterventionError)
        self.assertIs(executor_cls, MemoryExecutor)

    def test_new_names_are_in_all(self):
        for name in ("InteractionBoard", "InterventionError", "MemoryExecutor",
                     "INTERVENTION_KINDS", "summarize_kinds"):
            self.assertIn(name, BOTD_ALL, f"{name} 没进 __all__，`from botd import *` 会漏掉它")

    def test_pre_existing_exports_were_not_dropped(self):
        """别的模块在 import 这些名字；为了加导出把它们删了会连带炸掉别人。"""
        for name in ("BotStore", "TaskQueue", "Supervisor", "StepSpec", "RulePlanner",
                     "BotMemory", "BotDaemon", "SCHEMA_VERSION", "probe_external"):
            self.assertIn(name, BOTD_ALL)
        self.assertEqual(set(INTERVENTION_KINDS), {"pause", "resume", "retry", "takeover"})

    def test_memory_executor_from_root_actually_works(self):
        self.memory.remember("bot1", "从包根导入的执行器也要能用")
        executor = MemoryExecutor(BotMemory(self.store))
        result = executor("memory.recall", {"bot_id": "bot1", "query": "导入"})
        self.assertTrue(result["ok"])
        self.assertGreaterEqual(result["count"], 1)


# ================================================== 6. forest() 与 tree() 一致
class ForestMatchesTree(Base):
    def test_forest_step_count_equals_tree_counts_steps(self):
        run = self.run_memory_task()
        tree = self.board.tree(run.task_id)
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        self.assertEqual(entry["step_count"], tree["counts"]["steps"])

    def test_forest_done_and_failed_equal_tree_counts(self):
        run = self.run_memory_task()
        tree = self.board.tree(run.task_id)
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        self.assertEqual(entry["done"], tree["counts"]["done"])
        self.assertEqual(entry["failed"], tree["counts"]["failed"])

    def test_forest_counts_failed_task(self):
        run = self.run_failing_task()
        entry = next(f for f in self.board.forest() if f["task"]["task_id"] == run.task_id)
        tree = self.board.tree(run.task_id)
        self.assertEqual(entry["step_count"], 1)
        self.assertEqual(entry["failed"], 1)
        self.assertEqual(entry["failed"], tree["counts"]["failed"])

    def test_forest_lists_only_top_level_but_tree_sees_children(self):
        run = self.run_memory_task()
        top_ids = [f["task"]["task_id"] for f in self.board.forest()]
        self.assertIn(run.task_id, top_ids)
        for child in self.store.list_tasks(parent_task_id=run.task_id):
            self.assertNotIn(child["task_id"], top_ids, "首屏不该出现子任务")
        self.assertEqual(len(self.board.tree(run.task_id)["children"]), 2)


if __name__ == "__main__":
    unittest.main()
