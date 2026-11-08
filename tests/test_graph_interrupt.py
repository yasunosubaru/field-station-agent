# -*- coding: utf-8 -*-
"""Bot-3 验收：LangGraph 原生 ``interrupt()`` 闸门。

三条验收（计划书 Bot-3「改成什么样」）：

1. **闸门处真挂起** —— 杀掉进程，用同一 ``thread_id`` 恢复 → 从闸门继续
2. **已完成节点不重跑** —— 用**事件计数**验证，不是"看起来没重跑"
3. **原 gate 状态仍可读** —— 前端要能显示"卡在哪个闸门"

## 一条实测事实（决定了闸门怎么写）

``interrupt()`` **所在节点在恢复时会从函数开头重跑**：

```
run 1:  log = ['A-ran', 'gate-before']
resume: log = ['A-ran', 'gate-before', 'gate-before', 'gate-after', 'C-ran']
```

所以：

* ``A``（已完成节点）只跑一次 → 第 2 条验收成立；
* 闸门节点跑两次 → **``interrupt()`` 之前不许有副作用**，否则审批会被发两遍。

第 2 条的"事件计数"就是数 ``A-ran`` 出现几次，不是看结果对不对。
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fieldstation.graph import gate as gate_mod

ROOT = Path(__file__).resolve().parents[1]

#: 一个最小图：a → gate → c。用文件记录每次节点执行，跨进程也能数。
_CHILD = r"""
import sys, json
sys.path.insert(0, {src!r})
from pathlib import Path
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command
from fieldstation.graph.gate import make_checkpointer, thread_config, interrupt_value, GateAsk

work = Path({work!r})
log = work / "log.txt"

def mark(line):
    with log.open("a", encoding="utf-8") as f:
        f.write(line + "\n"); f.flush()

graph = StateGraph(dict)

def a(state):
    mark("A-ran")
    return {{"a": "done"}}

def gate(state):
    mark("gate-before")
    answer = GameAnswer = interrupt_value(GateAsk(stage="a", action="restart"))
    mark("gate-after:" + str(bool(answer)))
    return {{"approved": bool(answer)}}

def c(state):
    mark("C-ran")
    return {{"c": "done"}}

graph.add_node("a", a)
graph.add_node("gate", gate)
graph.add_node("c", c)
graph.add_edge(START, "a")
graph.add_edge("a", "gate")
graph.add_edge("gate", "c")
graph.add_edge("c", END)

saver = make_checkpointer(work / "cp.sqlite")
app = graph.compile(checkpointer=saver)
cfg = thread_config({thread!r})

if {should_resume!r}:
    out = app.invoke(Command(resume={{"approved": True, "by": "user:1"}}), config=cfg)
    print("RESUMED=" + json.dumps(out, default=str))
else:
    out = app.invoke({{"x": 1}}, config=cfg)
    print("PAUSED=" + str("__interrupt__" in out))
"""


def _skip_if_unavailable(case: unittest.TestCase) -> None:
    if not gate_mod.available():
        raise unittest.SkipTest("本机没有 langgraph interrupt / sqlite checkpointer")


def five_stage_local_stage(name: str, registry):
    """给五阶段的某个阶段造一条最小可用的 PipelineStage。"""
    from fieldstation.agents.pipeline import PipelineStage
    from fieldstation.agents.runtime import Agent

    class _Scripted:
        """最简 provider：不调模型，只回一句空话。够构造图，不跑真推理。"""

        def complete(self, *_args, **_kwargs):
            return {"content": "{}"}

    agent = Agent(name=name, system_prompt="", provider=_Scripted())
    return PipelineStage(name=name, agent=agent, registry=registry, topic=f"t.{name}")


class TestGatePrimitives(unittest.TestCase):
    def test_available_reports_true_here(self) -> None:
        # 这个仓库的 requirements-v4 里钉了 langgraph-checkpoint-sqlite，
        # 所以本机应该是可用的。不可用时**不能静默跳过**（门禁要求 skip=0）。
        self.assertTrue(
            gate_mod.available(),
            "闸门能力不可用：装 langgraph-checkpoint-sqlite（已在 requirements-v4）")

    def test_gate_answer_accepts_loose_input(self) -> None:
        self.assertTrue(gate_mod.GateAnswer.from_any({"approved": True}).approved)
        self.assertFalse(gate_mod.GateAnswer.from_any({"approved": False}).approved)
        self.assertTrue(gate_mod.GateAnswer.from_any("approved").approved)
        self.assertFalse(gate_mod.GateAnswer.from_any("rejected").approved)
        answer = gate_mod.GateAnswer.from_any({"approved": True, "by": "user:1"})
        self.assertEqual(answer.by, "user:1")

    def test_gate_ask_roundtrips(self) -> None:
        ask = gate_mod.GateAsk(stage="operations_dispatch", action="restart_receiver",
                               reason="连续缺测", risk="high", confidence=0.72,
                               detail={"station": "WUHN"})
        again = gate_mod.GateAsk.from_dict(ask.to_dict())
        self.assertEqual(again.stage, ask.stage)
        self.assertEqual(again.detail, {"station": "WUHN"})
        self.assertAlmostEqual(again.confidence, 0.72)

    def test_thread_config_shape(self) -> None:
        cfg = gate_mod.thread_config("th-1")
        self.assertEqual(cfg, {"configurable": {"thread_id": "th-1"}})


class TestCrossProcessResume(unittest.TestCase):
    """第 1、2 条验收：必须跨进程。"""

    def _run(self, work: Path, thread: str, should_resume: bool) -> subprocess.CompletedProcess:
        code = _CHILD.format(src=str(ROOT / "src"), work=str(work),
                             thread=thread, should_resume=should_resume)
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        return subprocess.run([sys.executable, "-c", code], capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              timeout=300, env=env, cwd=str(ROOT))

    def test_pause_then_resume_in_a_new_process(self) -> None:
        """第 1 条：杀掉进程（这里是另一个进程），用同一 thread_id 恢复。"""
        _skip_if_unavailable(self)
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            first = self._run(work, "t-1", should_resume=False)
            self.assertEqual(first.returncode, 0, first.stderr[-1200:])
            self.assertIn("PAUSED=True", first.stdout,
                          f"第一次跑就应该停在闸门：{first.stdout}")

            log = work / "log.txt"
            before = log.read_text(encoding="utf-8").split()
            self.assertEqual(before, ["A-ran", "gate-before"],
                             f"挂起时的执行痕迹不对：{before}")

            second = self._run(work, "t-1", should_resume=True)
            self.assertEqual(second.returncode, 0, second.stderr[-1200:])
            self.assertIn("RESUMED=", second.stdout)
            after = log.read_text(encoding="utf-8").split()

            # 第 2 条：已完成的 A 只出现一次（事件计数，不是看结果）
            self.assertEqual(after.count("A-ran"), 1,
                             f"已完成节点 A 重跑了：{after}")
            # 第 1 条续跑真的跑到了 C
            self.assertEqual(after.count("C-ran"), 1, f"续跑没跑到最后：{after}")
            # 闸门节点确实重跑（实测语义），且只多一次
            self.assertEqual(after.count("gate-before"), 2,
                             f"闸门节点应重跑一次（interrupt 的语义）：{after}")

    def test_resume_without_the_thread_id_cannot_continue(self) -> None:
        """换一条线程就接不上 —— 证明续跑真的是靠 thread_id + 检查点。

        **注意实测语义**：在别的线程上 ``Command(resume=...)`` **不报错**，
        而是返回 ``None`` 什么也不做。所以判据不能是"退出码非 0"，
        必须是"原线程的活没被干完"。这一点很危险：静默失效看起来像成功。
        """
        _skip_if_unavailable(self)
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            first = self._run(work, "t-original", should_resume=False)
            self.assertIn("PAUSED=True", first.stdout)
            log = work / "log.txt"
            self.assertEqual(log.read_text(encoding="utf-8").split(),
                             ["A-ran", "gate-before"])

            # 用另一个 thread_id 去 resume：它接不到原线程的快照
            other = self._run(work, "t-other", should_resume=True)
            lines = log.read_text(encoding="utf-8").split()
            self.assertEqual(lines.count("C-ran"), 0,
                             f"另一条线程把原线程的活干完了，说明检查点没起作用：{lines}")
            self.assertEqual(lines.count("A-ran"), 1,
                             f"另一条线程重跑了已完成的节点：{lines}")
            # 静默失败也要留痕迹：返回 None 而不是结果
            self.assertIn("RESUMED=null", other.stdout,
                          f"另一条线程 resume 应该是空操作：{other.stdout}")


class TestGateStateReadable(unittest.TestCase):
    """第 3 条：闸门状态仍可读（前端要显示"卡在哪"）。"""

    def test_gate_status_is_exposed_while_paused(self) -> None:
        _skip_if_unavailable(self)
        from langgraph.graph import END, START, StateGraph

        from fieldstation.graph import five_stage

        graph = StateGraph(dict)

        def a(state: dict) -> dict:
            return {"a": 1}

        def gate(state: dict) -> dict:
            answer = gate_mod.interrupt_value(
                gate_mod.GateAsk(stage="a", action="restart"))
            return {five_stage.GATE_KEY_PREFIX + "a": answer.to_dict()}

        def c(state: dict) -> dict:
            return {"c": 1}

        graph.add_node("a", a)
        graph.add_node("gate_a", gate)
        graph.add_node("c", c)
        graph.add_edge(START, "a")
        graph.add_edge("a", "gate_a")
        graph.add_edge("gate_a", "c")
        graph.add_edge("c", END)

        with tempfile.TemporaryDirectory() as td:
            saver = gate_mod.make_checkpointer(Path(td) / "cp.sqlite")
            app = graph.compile(checkpointer=saver)
            cfg = gate_mod.thread_config("th-x")
            out = app.invoke({"x": 1}, config=cfg)

            # 挂起标记在
            self.assertTrue(five_stage._paused_at(out),
                            "图应该停在闸门上")
            status = five_stage._gate_status(out)
            self.assertTrue(status["paused"])
            self.assertEqual(status["ask"]["stage"], "a")
            self.assertEqual(status["ask"]["action"], "restart")
            # Windows 上临时目录删不掉是 sqlite 连接还开着：显式关掉。
            # 不加这两行，tearDown 会抛 PermissionError（WinError 32）。
            try:
                saver.conn.close()
            except Exception:  # noqa: BLE001 - 关不掉不算用例失败
                pass


class TestRunFiveStageGateWiring(unittest.TestCase):
    """``run_five_stage`` 的闸门参数校验：缺条件必须显式报错。"""

    def _stages(self):
        from fieldstation.agents.tools import ToolRegistry

        registry = ToolRegistry()
        return [five_stage_local_stage(name, registry)
                for name in ("qc", "device_monitor", "fault_diagnosis",
                             "operations_dispatch", "archive")]

    def test_gate_needs_langgraph_engine(self) -> None:
        from fieldstation.agents.bus import MessageBus
        from fieldstation.graph import five_stage

        with self.assertRaises(ValueError) as ctx:
            five_stage.run_five_stage(
                self._stages(), bus=MessageBus(), trace_path="x.jsonl",
                engine="builtin", gate_stages=("qc",), thread_id="t",
                gate_checkpointer=object())
        self.assertIn("langgraph", str(ctx.exception))

    def test_gate_needs_checkpointer(self) -> None:
        from fieldstation.agents.bus import MessageBus
        from fieldstation.graph import five_stage

        with self.assertRaises(ValueError) as ctx:
            five_stage.run_five_stage(
                self._stages(), bus=MessageBus(), trace_path="x.jsonl",
                engine="langgraph", gate_stages=("qc",), thread_id="t")
        self.assertIn("checkpointer", str(ctx.exception))

    def test_gate_needs_thread_id(self) -> None:
        from fieldstation.agents.bus import MessageBus
        from fieldstation.graph import five_stage

        with self.assertRaises(ValueError) as ctx:
            five_stage.run_five_stage(
                self._stages(), bus=MessageBus(), trace_path="x.jsonl",
                engine="langgraph", gate_stages=("qc",),
                gate_checkpointer=object())
        self.assertIn("thread_id", str(ctx.exception))

    def test_unknown_gate_stage_rejected(self) -> None:
        """闸门阶段名不在五阶段里要拒绝。

        注意校验顺序：先校验「五阶段齐不齐」，再校验闸门名。所以这里要给
        一份完整的 pipelines 才能走到闸门校验。
        """
        from fieldstation.agents.bus import MessageBus
        from fieldstation.agents.pipeline import Pipeline
        from fieldstation.agents.tools import ToolRegistry
        from fieldstation.graph import five_stage

        registry = ToolRegistry()
        pipelines = {}
        for name in five_stage.STAGE_ORDER:
            stage = five_stage_local_stage(name, registry)
            pipelines[name] = Pipeline(MessageBus(), "t.jsonl", [stage])

        with self.assertRaises(ValueError) as ctx:
            five_stage.build_five_stage_graph(pipelines, (), gate_stages=("nope",))
        self.assertIn("nope", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
