"""节点级检查点：JSONL 写读、摘要口径、按 thread_id 恢复与跳过。

检查点只保存摘要（同 trace 的 ``result_digest`` 纪律），所以恢复时
**产物必须由调用方随 state 一起传入** —— 这些用例正是按这个契约写的。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.graph.checkpoint import (
    CHECKPOINT_KIND,
    CheckpointError,
    CheckpointStore,
)
from fieldstation.graph.state_graph import (
    GraphExecutionError,
    StateGraph,
    digest_of,
)

FIXED_TS = "2026-11-05T00:00:00+00:00"


def _two_node_graph(calls: list[str]) -> StateGraph:
    def first(state):
        calls.append("first")
        return {"a": state.get("seed", 0) + 1}

    def second(state):
        calls.append("second")
        return {"b": state["a"] + 1}

    graph = StateGraph(dict)
    graph.add_node("first", first)
    graph.add_node("second", second)
    graph.add_edge("first", "second")
    return graph


class TestCheckpointWriteRead(unittest.TestCase):
    def test_each_node_execution_writes_one_record(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ckpt.jsonl"
            store = CheckpointStore(path, clock=lambda: FIXED_TS)
            compiled = _two_node_graph([]).compile()
            state = compiled.invoke({"seed": 1}, thread_id="run-1",
                                    checkpoint=store)
            self.assertEqual(state, {"seed": 1, "a": 2, "b": 3})

            records = store.read()
            self.assertEqual([r["node"] for r in records], ["first", "second"])
            self.assertEqual([r["thread_id"] for r in records],
                             ["run-1", "run-1"])
            for record in records:
                self.assertEqual(set(record), {
                    "kind", "thread_id", "node", "input_digest",
                    "output_digest", "ts"})
                self.assertEqual(record["kind"], CHECKPOINT_KIND)
                self.assertEqual(record["ts"], FIXED_TS)

            # 输入/输出摘要必须能被独立复算：first 的输入是 {"seed":1}、
            # 输出是 {"a":2}；second 的输入是合并后的状态。
            self.assertEqual(records[0]["input_digest"], digest_of({"seed": 1}))
            self.assertEqual(records[0]["output_digest"], digest_of({"a": 2}))
            self.assertEqual(records[1]["input_digest"],
                             digest_of({"seed": 1, "a": 2}))
            self.assertEqual(records[1]["output_digest"], digest_of({"b": 3}))

    def test_file_is_compact_jsonl_with_lf(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "nested" / "ckpt.jsonl"
            store = CheckpointStore(path, clock=lambda: FIXED_TS)
            _two_node_graph([]).compile().invoke(
                {}, thread_id="t", checkpoint=store)
            raw = path.read_bytes()
            self.assertNotIn(b"\r\n", raw)
            self.assertTrue(raw.endswith(b"\n"))
            first_line = raw.decode("utf-8").splitlines()[0]
            self.assertNotIn(", ", first_line)   # 紧凑分隔符
            self.assertEqual(json.loads(first_line)["node"], "first")

    def test_completed_and_resume_read_back_by_thread(self):
        with tempfile.TemporaryDirectory() as td:
            store = CheckpointStore(Path(td) / "ckpt.jsonl",
                                    clock=lambda: FIXED_TS)
            store.record("t1", "first", input_digest="i1", output_digest="o1")
            store.record("t1", "second", input_digest="i2", output_digest="o2")
            store.record("t2", "first", input_digest="i3", output_digest="o3")

            self.assertEqual(store.resume("t1"), frozenset({"first", "second"}))
            self.assertEqual(store.resume("t2"), frozenset({"first"}))
            self.assertEqual(store.threads(), ["t1", "t2"])
            self.assertEqual(store.completed("t1")["second"]["output_digest"], "o2")

    def test_last_record_wins_for_same_node(self):
        with tempfile.TemporaryDirectory() as td:
            store = CheckpointStore(Path(td) / "ckpt.jsonl",
                                    clock=lambda: FIXED_TS)
            store.record("t", "first", input_digest="i1", output_digest="old")
            store.record("t", "first", input_digest="i2", output_digest="new")
            self.assertEqual(store.completed("t")["first"]["output_digest"], "new")

    def test_broken_line_reports_line_number(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ckpt.jsonl"
            path.write_text(
                json.dumps({"kind": CHECKPOINT_KIND, "thread_id": "t",
                            "node": "first", "input_digest": "i",
                            "output_digest": "o", "ts": FIXED_TS}) + "\n"
                + "not json\n", encoding="utf-8")
            store = CheckpointStore(path)
            with self.assertRaises(CheckpointError) as ctx:
                store.read()
            self.assertIn("第 2 行", str(ctx.exception))

    def test_missing_fields_rejected_on_read(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ckpt.jsonl"
            path.write_text(json.dumps({"kind": "graph_checkpoint"}) + "\n",
                            encoding="utf-8")
            with self.assertRaises(CheckpointError) as ctx:
                CheckpointStore(path).read()
            self.assertIn("缺字段", str(ctx.exception))


class TestResume(unittest.TestCase):
    def test_resume_skips_completed_nodes(self):
        with tempfile.TemporaryDirectory() as td:
            store = CheckpointStore(Path(td) / "ckpt.jsonl",
                                    clock=lambda: FIXED_TS)
            calls: list[str] = []
            compiled = _two_node_graph(calls).compile()

            first_state = compiled.invoke({"seed": 1}, thread_id="run",
                                          checkpoint=store)
            self.assertEqual(calls, ["first", "second"])

            calls.clear()
            # 自动 resume：两个节点都已完成 → 一个都不再执行，状态原样返回。
            state = compiled.invoke(first_state, thread_id="run",
                                    checkpoint=store)
            self.assertEqual(calls, [])
            self.assertEqual(state, first_state)

            calls.clear()
            second_state = compiled.invoke({"seed": 1, "a": 2},
                                           thread_id="run", checkpoint=store,
                                           resume={"first"})
            self.assertEqual(calls, ["second"])
            self.assertEqual(second_state, {"seed": 1, "a": 2, "b": 3})

    def test_resume_does_not_leak_across_threads(self):
        with tempfile.TemporaryDirectory() as td:
            store = CheckpointStore(Path(td) / "ckpt.jsonl",
                                    clock=lambda: FIXED_TS)
            store.record("other", "first", input_digest="i", output_digest="o")
            calls: list[str] = []
            compiled = _two_node_graph(calls).compile()
            compiled.invoke({"seed": 1}, thread_id="mine", checkpoint=store)
            self.assertEqual(calls, ["first", "second"])

    def test_unknown_resume_node_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            store = CheckpointStore(Path(td) / "ckpt.jsonl",
                                    clock=lambda: FIXED_TS)
            compiled = _two_node_graph([]).compile()
            with self.assertRaises(GraphExecutionError):
                compiled.invoke({}, thread_id="t", checkpoint=store,
                                resume={"nope"})

    def test_checkpoint_requires_thread_id(self):
        with tempfile.TemporaryDirectory() as td:
            store = CheckpointStore(Path(td) / "ckpt.jsonl")
            with self.assertRaises(ValueError):
                _two_node_graph([]).compile().invoke({}, checkpoint=store)


if __name__ == "__main__":
    unittest.main()
