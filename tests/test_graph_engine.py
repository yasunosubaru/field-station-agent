"""状态图引擎：顺序执行、条件分支、并行汇合、增量合并与定义错误。

这些用例**不依赖 langgraph**：自带 runner 是默认路径，可选适配层另有一套
探测逻辑（没装时只会在 ``EngineUnavailable`` 分支里出现）。
"""
from __future__ import annotations

import unittest

from fieldstation.graph.state_graph import (
    GraphDefinitionError,
    GraphExecutionError,
    StateGraph,
    digest_of,
)


class TestLinearAndMerge(unittest.TestCase):
    def test_nodes_run_in_declaration_order_and_merge_incrementally(self):
        graph = StateGraph(dict)
        seen: list[str] = []

        def first(state):
            seen.append("first")
            return {"a": state["seed"] + 1}

        def second(state):
            seen.append("second")
            # 增量合并：second 能看到 first 刚写进状态的 a，但没被要求重算 seed。
            return {"b": state["a"] * 10}

        graph.add_node("first", first)
        graph.add_node("second", second)
        graph.add_edge("first", "second")

        result = graph.compile().invoke({"seed": 1})
        self.assertEqual(result, {"seed": 1, "a": 2, "b": 20})
        self.assertEqual(seen, ["first", "second"])

    def test_node_returning_none_leaves_state_untouched(self):
        graph = StateGraph(dict)
        graph.add_node("noop", lambda state: None)
        graph.add_node("mark", lambda state: {"marked": True})
        graph.add_edge("noop", "mark")
        self.assertEqual(graph.compile().invoke({"x": 1}),
                         {"x": 1, "marked": True})

    def test_shallow_merge_overwrites_same_key(self):
        graph = StateGraph(dict)
        graph.add_node("a", lambda state: {"value": "a"})
        graph.add_node("b", lambda state: {"value": "b"})
        graph.add_edge("a", "b")
        self.assertEqual(graph.compile().invoke({})["value"], "b")

    def test_digest_is_stable_across_key_order(self):
        self.assertEqual(digest_of({"a": 1, "b": [2, 3]}),
                         digest_of({"b": [2, 3], "a": 1}))
        self.assertEqual(len(digest_of({"a": 1})), 16)


class TestConditionalEdges(unittest.TestCase):
    def _branch_graph(self):
        graph = StateGraph(dict)
        graph.add_node("start", lambda state: {"flag": state["flag"]})
        graph.add_node("left", lambda state: {"took": "left"})
        graph.add_node("right", lambda state: {"took": "right"})
        graph.add_conditional_edges(
            "start",
            lambda state: "right" if state["flag"] else "left",
            {"left": "left", "right": "right"},
        )
        return graph

    def test_only_the_chosen_branch_runs(self):
        graph = self._branch_graph()
        result = graph.compile().invoke({"flag": True})
        self.assertEqual(result["took"], "right")
        # 未命中的分支被跳过：状态里不会出现它的产物。
        right_only = graph.compile().invoke({"flag": False})
        self.assertEqual(right_only["took"], "left")

    def test_router_can_return_a_list_of_targets(self):
        graph = StateGraph(dict)
        graph.add_node("start", lambda state: {})
        graph.add_node("left", lambda state: {"left": True})
        graph.add_node("right", lambda state: {"right": True})
        graph.add_conditional_edges(
            "start", lambda state: ["left", "right"],
            {"left": "left", "right": "right"})
        result = graph.compile().invoke({})
        self.assertTrue(result["left"])
        self.assertTrue(result["right"])

    def test_router_without_mapping_skips_unchosen_nodes(self):
        graph = StateGraph(dict)
        graph.add_node("start", lambda state: {"flag": state["flag"]})
        graph.add_node("chosen", lambda state: {"chosen": True})
        graph.add_node("other", lambda state: {"other": True})
        graph.add_conditional_edges(
            "start", lambda state: "chosen" if state["flag"] else "other")
        result = graph.compile().invoke({"flag": True})
        self.assertTrue(result["chosen"])
        self.assertNotIn("other", result)

    def test_mapping_to_unknown_node_is_rejected_at_compile(self):
        graph = StateGraph(dict)
        graph.add_node("a", lambda state: {})
        graph.add_conditional_edges("a", lambda state: "b", {"x": "missing"})
        with self.assertRaises(GraphDefinitionError):
            graph.compile()


class TestParallelJoin(unittest.TestCase):
    def test_join_node_waits_for_both_upstreams(self):
        graph = StateGraph(dict)
        order: list[str] = []

        def start(state):
            order.append("start")
            return {"started": True}

        def branch_b(state):
            order.append("b")
            # b 先跑：此时 c 还没产物。
            self.assertNotIn("c", state)
            return {"b": 1}

        def branch_c(state):
            order.append("c")
            self.assertIn("b", state)
            return {"c": 2}

        def join(state):
            order.append("join")
            # 汇合点必须同时看到两条上游的产物。
            self.assertEqual((state["b"], state["c"]), (1, 2))
            return {"sum": state["b"] + state["c"]}

        graph.add_node("start", start)
        graph.add_node("b", branch_b)
        graph.add_node("c", branch_c)
        graph.add_node("join", join)
        graph.add_edge("start", "b")
        graph.add_edge("start", "c")
        graph.add_edge("b", "join")
        graph.add_edge("c", "join")

        result = graph.compile().invoke({})
        self.assertEqual(result["sum"], 3)
        self.assertEqual(order, ["start", "b", "c", "join"])

    def test_join_runs_with_the_surviving_branch(self):
        """条件分支二选一后汇合：跳过的分支不阻塞，存活分支的产物进汇合点。"""
        graph = StateGraph(dict)
        graph.add_node("start", lambda state: {"flag": state["flag"]})
        graph.add_node("taken", lambda state: {"value": 1})
        graph.add_node("dropped", lambda state: {"value": 2})
        graph.add_node("join", lambda state: {"joined": state["value"]})
        graph.add_conditional_edges(
            "start", lambda state: "taken" if state["flag"] else "dropped",
            {"taken": "taken", "dropped": "dropped"})
        graph.add_edge("taken", "join")
        graph.add_edge("dropped", "join")
        result = graph.compile().invoke({"flag": True})
        self.assertEqual(result["value"], 1)
        self.assertEqual(result["joined"], 1)


class TestDefinitionErrors(unittest.TestCase):
    def _graph(self):
        graph = StateGraph(dict)
        graph.add_node("a", lambda state: {})
        graph.add_node("b", lambda state: {})
        return graph

    def test_duplicate_node_rejected(self):
        graph = self._graph()
        with self.assertRaises(GraphDefinitionError):
            graph.add_node("a", lambda state: {})

    def test_unknown_edge_endpoint_rejected(self):
        graph = self._graph()
        graph.add_edge("a", "missing")
        with self.assertRaises(GraphDefinitionError):
            graph.compile()

    def test_cycle_rejected(self):
        graph = self._graph()
        graph.add_edge("a", "b")
        graph.add_edge("b", "a")
        with self.assertRaises(GraphDefinitionError):
            graph.compile()

    def test_empty_graph_rejected(self):
        with self.assertRaises(GraphDefinitionError):
            StateGraph(dict).compile()

    def test_node_must_return_dict_or_none(self):
        graph = StateGraph(dict)
        graph.add_node("bad", lambda state: 42)
        with self.assertRaises(GraphExecutionError):
            graph.compile().invoke({})

    def test_compiled_graph_exposes_spec(self):
        graph = self._graph()
        compiled = graph.compile()
        self.assertEqual(set(compiled.spec_dict()["nodes"]), {"a", "b"})
        # 编译后定义器被冻结，不能再加节点；但可以再次 compile 得到新快照。
        with self.assertRaises(GraphDefinitionError):
            graph.add_node("c", lambda state: {})
        compiled_again = graph.compile()
        self.assertEqual(compiled_again.spec.node_names, ("a", "b"))


if __name__ == "__main__":
    unittest.main()
