"""LangGraph 适配层：装了 langgraph 才跑，没装就跳过（不是失败）。

两个用例覆盖 2026-11-05 实测踩到的两个坑：

1. ``StateGraph(dict)`` 在 LangGraph 1.x 里是单个 ``__root__`` 通道（LastValue），
   同一超步两个节点各写一次就报 ``InvalidUpdateError`` —— 适配层用根 reducer
   把并行分支的写入合并；
2. 普通边是**逐边触发**：一个节点有多条普通入边时会在每个上游完成时各跑一遍
   （五阶段里 ``device_monitor`` 会跑两遍、脚本化 provider 被用尽）—— 适配层
   把同目标的边合并成 fan-in 边，等全部上游完成才执行一次。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.graph import adapter_langgraph
from fieldstation.graph.parity import DEFAULT_FIXTURE, compare, load_scenario
from fieldstation.graph.state_graph import StateGraph

LANGGRAPH = adapter_langgraph.available()


def _diamond_graph():
    graph = StateGraph(dict)
    graph.add_node("start", lambda state: {"started": True})
    graph.add_node("left", lambda state: {"left": True})
    graph.add_node("right", lambda state: {"right": True})
    graph.add_node("join", lambda state: {
        "sum": int(bool(state.get("left"))) + int(bool(state.get("right")))})
    graph.add_edge("start", "left")
    graph.add_edge("start", "right")
    graph.add_edge("left", "join")
    graph.add_edge("right", "join")
    return graph


@unittest.skipUnless(LANGGRAPH, "未安装 langgraph：可选适配层跳过")
class TestLangGraphAdapter(unittest.TestCase):
    def test_parallel_branches_merge_instead_of_conflicting(self):
        """两分支同一步各写自己的键：根 reducer 合并，不抛 InvalidUpdateError。"""
        compiled = _diamond_graph().compile()
        runner = adapter_langgraph.compile_graph(compiled.spec)
        state = runner.invoke({})
        self.assertTrue(state["started"])
        self.assertTrue(state["left"])
        self.assertTrue(state["right"])
        self.assertEqual(state["sum"], 2)

    def test_fan_in_edge_runs_join_once_after_both_branches(self):
        graph = StateGraph(dict)
        calls = {"join": 0}

        def join(state):
            calls["join"] += 1
            return {"saw": sorted(key for key in state if key.startswith("k_"))}

        graph.add_node("start", lambda state: {})
        graph.add_node("a", lambda state: {"k_a": 1})
        graph.add_node("b", lambda state: {"k_b": 1})
        graph.add_node("join", join)
        graph.add_edge("start", "a")
        graph.add_edge("start", "b")
        graph.add_edge("a", "join")
        graph.add_edge("b", "join")
        runner = adapter_langgraph.compile_graph(graph.compile().spec)
        state = runner.invoke({})
        self.assertEqual(calls["join"], 1)
        self.assertEqual(state["saw"], ["k_a", "k_b"])

    def test_five_stage_parity_under_langgraph(self):
        scenario = load_scenario(DEFAULT_FIXTURE)
        with tempfile.TemporaryDirectory() as td:
            _pipeline_records, _graph_records, problems = compare(
                scenario, td, engine="langgraph")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_engine_unavailable_is_reported_when_not_importable(self):
        from unittest import mock

        compiled = _diamond_graph().compile()
        with mock.patch.object(adapter_langgraph, "available", return_value=False):
            with self.assertRaises(adapter_langgraph.EngineUnavailable):
                adapter_langgraph.compile_graph(compiled.spec)


if __name__ == "__main__":
    unittest.main()
