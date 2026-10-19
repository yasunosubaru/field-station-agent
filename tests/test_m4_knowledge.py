"""M4-0：SQLite FTS5 知识库与检索工具。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.agents.knowledge import (
    KnowledgeBase,
    KnowledgeSearchTool,
    load_documents,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "data" / "kb" / "knowledge.jsonl"
QUERIES = ROOT / "data" / "kb" / "smoke_queries.json"


class TestKnowledgeBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.kb = KnowledgeBase(Path(self.tmp.name) / "kb.sqlite3")
        self.kb.index(load_documents(DOCS))

    def tearDown(self):
        self.tmp.cleanup()

    def test_search_finds_nonphysical_rmse(self):
        rows = self.kb.search("非物理 RMSE 500 TECU", limit=5)
        self.assertTrue(rows)
        self.assertEqual(rows[0]["doc_id"], "qc-nonphysical-rmse")

    def test_no_hit_returns_empty(self):
        self.assertEqual(self.kb.search("完全不存在的火星设备规程", limit=5), [])

    def test_empty_query_rejected(self):
        with self.assertRaises(ValueError):
            self.kb.search("   ")

    def test_ten_question_smoke_hit_rate(self):
        data = json.loads(QUERIES.read_text(encoding="utf-8"))
        cases = data["in_scope"]
        self.assertEqual(len(cases), 10)
        failures = []
        for case in cases:
            ids = [row["doc_id"] for row in self.kb.search(case["query"], limit=3)]
            if case["expected_id"] not in ids:
                failures.append({"query": case["query"],
                                 "expected": case["expected_id"],
                                 "actual": ids})
        self.assertGreaterEqual(10 - len(failures), 8, failures)

    def test_open_probes_are_not_claimed_as_covered(self):
        """库内无对应条目的开放问题：只记录行为，不冒充知识覆盖。"""
        data = json.loads(QUERIES.read_text(encoding="utf-8"))
        self.assertEqual(len(data["probes"]), 3)
        for probe in data["probes"]:
            self.assertTrue(probe["query"].strip())
            self.assertTrue(probe["note"].strip())

    def test_search_tool_returns_json_friendly_results(self):
        tool = KnowledgeSearchTool(self.kb)
        result = tool.invoke({"query": "网络中断 数据未上报", "limit": 3})
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["count"], len(result.data["results"]))
        json.dumps(result.data, ensure_ascii=False)

    def test_tool_bad_limit_is_clear(self):
        tool = KnowledgeSearchTool(self.kb)
        result = tool.invoke({"query": "网络", "limit": 0})
        self.assertFalse(result.ok)
        self.assertIn("limit", result.error or "")


if __name__ == "__main__":
    unittest.main()
